//go:build !linux

package main

func setSocketOptions(int) error { return nil }

func reusePortCount() int { return 1 }
