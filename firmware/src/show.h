// ESPectacle - music shows. The app compiles its timeline into segments (one effect on one
// plant/zone between two times) and uploads them; playback runs on the controller's own
// uptime clock, so every controller stays in step with the music without streaming.
#pragma once
#include <Arduino.h>
#include "effects.h"

struct ShowSeg {
  uint32_t t0, t1;     // ms from the start of the show
  uint32_t p0;         // when this clip's animation started (<= t0): keeps its phase when a clip
                       // is interrupted by another track and then resumes
  uint32_t c1, c2;
  uint16_t rate;
  uint8_t  zone, fx, pal, bri, scl;
  uint8_t  frameMode;  // FRAME_* (effects.h)
  Frame    group;      // for FRAME_GROUP
  uint8_t  hasDir;     // direction of travel for moving effects
  int16_t  dx, dy, dz;
};

bool     showBegin(uint32_t id, uint16_t count);   // allocate; stops any playback
bool     showAdd(uint16_t idx, const ShowSeg &s);
bool     showCommit();                             // checks the upload is complete
void     showClear();
void     showPlay(int64_t startUpMs);              // uptime (ms) at which show time 0 happens
void     showStop();
bool     showPlaying();
// Blackout: all LEDs off until the app plays a show or sets a normal look again. Used while a
// show is being edited, and after a show finishes.
void     showBlackout(bool on);
bool     showBlackedOut();
uint32_t showId();
uint16_t showCount();
uint32_t showLengthMs();
size_t   showMaxSegments();                        // how many segments fit in free memory

// Prepares one context per zone for the current frame. Returns false when the show has
// finished (playback then stops by itself).
bool     showFrame(uint64_t upMs, FxCtx *ctx);
