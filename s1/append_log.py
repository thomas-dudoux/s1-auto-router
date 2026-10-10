"""Append one private decision line, also tightening an existing file's mode."""
import fcntl
import os
import sys


def main():
    path = sys.argv[1]
    data = sys.stdin.buffer.read()
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        os.fchmod(fd, 0o600)
        fcntl.flock(fd, fcntl.LOCK_EX)
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            if written == 0:
                raise OSError("decision append made no progress")
            view = view[written:]
    finally:
        os.close(fd)


if __name__ == "__main__":
    main()
