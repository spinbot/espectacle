import AVFoundation

/// Reads a music file once to draw its waveform and guess its tempo.
struct AudioAnalysis {
    static let rate = 100.0                 // envelope samples per second

    var duration: Double
    var envelope: [Float]                   // 0...1 loudness at `rate` per second
    var bpm: Double?
    var beatOffset: Double                  // seconds to the first beat

    static func analyze(url: URL) throws -> AudioAnalysis {
        let file = try AVAudioFile(forReading: url)
        let format = file.processingFormat
        let sr = format.sampleRate
        let hop = max(1, Int(sr / rate))
        let total = Int(file.length)
        let chunk: AVAudioFrameCount = 65536
        guard let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: chunk) else {
            throw APIError(message: "Couldn't read the audio file")
        }

        var env: [Float] = []
        env.reserveCapacity(total / hop + 1)
        var acc: Float = 0
        var n = 0
        while file.framePosition < file.length {
            try file.read(into: buf, frameCount: chunk)
            let frames = Int(buf.frameLength)
            if frames == 0 { break }
            guard let ch = buf.floatChannelData else { break }
            let channels = Int(format.channelCount)
            for i in 0..<frames {
                var v: Float = 0
                for c in 0..<channels { v += ch[c][i] * ch[c][i] }
                acc += v / Float(channels)
                n += 1
                if n == hop {
                    env.append((acc / Float(n)).squareRoot())
                    acc = 0
                    n = 0
                }
            }
        }
        let peak = max(env.max() ?? 1, 1e-6)
        let norm = env.map { min(1, $0 / peak) }
        let duration = Double(total) / sr
        let tempo = estimateTempo(norm)
        return AudioAnalysis(duration: duration, envelope: norm, bpm: tempo?.bpm, beatOffset: tempo?.offset ?? 0)
    }

    /// Onset strength -> autocorrelation over 70–180 BPM -> best beat phase.
    static func estimateTempo(_ env: [Float]) -> (bpm: Double, offset: Double)? {
        guard env.count > Int(rate * 8) else { return nil }
        // Onset strength: rises in log loudness, minus a running average.
        var onset = [Float](repeating: 0, count: env.count)
        for i in 1..<env.count {
            onset[i] = max(0, log(1 + 100 * env[i]) - log(1 + 100 * env[i - 1]))
        }
        let w = Int(rate / 2)
        var smooth = onset
        var run: Float = 0
        for i in 0..<onset.count {
            run += onset[i]
            if i >= w { run -= onset[i - w] }
            smooth[i] = max(0, onset[i] - run / Float(min(i + 1, w)))
        }

        let minLag = Int(rate * 60 / 180), maxLag = Int(rate * 60 / 70)
        var score = [Double](repeating: 0, count: maxLag + 2)
        for lag in minLag...(maxLag + 1) {
            var s: Double = 0
            for i in lag..<smooth.count { s += Double(smooth[i] * smooth[i - lag]) }
            // Mild preference for tempos near 120 BPM, as most music sits there.
            let bpm = rate * 60 / Double(lag)
            let prior = exp(-0.5 * pow(log2(bpm / 120) / 0.9, 2))
            score[lag] = s * prior
        }
        guard let best = (minLag...maxLag).max(by: { score[$0] < score[$1] }), score[best] > 0 else { return nil }
        // Parabolic refinement between neighbouring lags.
        var lag = Double(best)
        let a = score[best - 1 >= minLag ? best - 1 : best], b = score[best], c = score[best + 1]
        let denom = a - 2 * b + c
        if denom < 0 { lag += 0.5 * (a - c) / denom }
        // Fine-tune tempo and find the beat phase together: the grid that lands on the most
        // onset strength across the whole song (small tempo errors add up over minutes).
        var bestLag = lag, bestPhase = 0, bestSum: Float = -1
        for k in -50...50 {
            let l = lag + Double(k) * 0.02
            for phase in 0..<Int(l.rounded(.up)) {
                var s: Float = 0
                var n = 0
                var t = Double(phase)
                while Int(t) < smooth.count {
                    s += smooth[Int(t)]
                    t += l
                    n += 1
                }
                s /= Float(max(n, 1))
                if s > bestSum { bestSum = s; bestPhase = phase; bestLag = l }
            }
        }
        let bpm = rate * 60 / bestLag
        return ((bpm * 10).rounded() / 10, Double(bestPhase) / rate)
    }
}
