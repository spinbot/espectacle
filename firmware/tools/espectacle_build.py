# PlatformIO extra script (see platformio.ini).
#  - Defines ESPECTACLE_BOARD as the environment name, so the firmware (and its .bin) say which board
#    they are for. The ESPectacle server only offers a firmware file to controllers of the same board.
#  - After a build, copies firmware.bin to ../server/data/firmware/espectacle-<version>-<env>.bin, where
#    the server (and its website: Devices tab) picks it up for over-the-air updates. If your server's
#    data folder is somewhere else, set ESPECTACLE_FIRMWARE_DIR, or upload the .bin on the website.
import os
import re
import shutil

Import("env")  # noqa: F821  (provided by PlatformIO)

board = env["PIOENV"]
env.Append(CPPDEFINES=[("ESPECTACLE_BOARD", env.StringifyMacro(board))])


def _version():
    try:
        with open(os.path.join(env["PROJECT_SRC_DIR"], "settings.h")) as f:
            m = re.search(r'#define\s+FW_VERSION\s+"([^"]+)"', f.read())
            return m.group(1) if m else "dev"
    except OSError:
        return "dev"


def _copy_firmware(source, target, env):
    out = os.environ.get("ESPECTACLE_FIRMWARE_DIR") or os.environ.get("TREELIGHTS_FIRMWARE_DIR") or os.path.join(env["PROJECT_DIR"], "..", "server", "data", "firmware")
    out = os.path.abspath(out)
    if not os.path.isdir(os.path.dirname(out)):
        print("ESPectacle: no server data folder at %s; upload the .bin on the website instead." % os.path.dirname(out))
        return
    os.makedirs(out, exist_ok=True)
    name = "espectacle-%s-%s.bin" % (_version(), board)
    shutil.copyfile(str(target[0]), os.path.join(out, name))
    print("ESPectacle: copied firmware to %s" % os.path.join(out, name))


env.AddPostAction("$BUILD_DIR/${PROGNAME}.bin", _copy_firmware)
