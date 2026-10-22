package main

import (
	"runtime"

	"golang.org/x/sys/unix"
)

func setSocketOptions(fd int) error {
	if err := unix.SetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_REUSEPORT, 1); err != nil {
		return err
	}
	_ = unix.SetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_RCVBUF, 8<<20)
	_ = unix.SetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_SNDBUF, 8<<20)
	return nil
}

func reusePortCount() int { return runtime.NumCPU() }
