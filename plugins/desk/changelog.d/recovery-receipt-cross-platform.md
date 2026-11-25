The queued-log readback tests count Git hash-object runs with Git's own trace2 stream and a node clean-filter spy, so their hash-once and zero-read checks run on Windows as well as POSIX.
