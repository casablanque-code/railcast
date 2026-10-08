# Fails if a 64-bit Mach-O binary has no LC_UUID load command.
# macOS (dyld) refuses to start such binaries: "missing LC_UUID load command".
# Go 1.22 builds darwin binaries without it.
import struct, sys

path = sys.argv[1]
data = open(path, "rb").read()
magic = struct.unpack_from("<I", data, 0)[0]
if magic != 0xFEEDFACF:
    sys.exit(f"{path}: not a 64-bit little-endian Mach-O (magic {magic:#x})")
ncmds = struct.unpack_from("<I", data, 16)[0]
offset = 32
found = False
for _ in range(ncmds):
    cmd, size = struct.unpack_from("<II", data, offset)
    if cmd == 0x1B:  # LC_UUID
        found = True
    offset += size
print(f"{path}: LC_UUID {'present' if found else 'MISSING'}")
sys.exit(0 if found else 1)
