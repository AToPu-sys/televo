package main

import (
	"fmt"
	"net"
)

// Peers a relay must never reach: private networks, loopback, link-local
// (incl. the cloud metadata service 169.254.169.254), CGNAT, multicast,
// documentation and reserved ranges.
var deniedPeerRanges = []string{
	"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16",
	"172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15",
	"198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4",
	"::/128", "::1/128", "64:ff9b::/96", "100::/64", "2001:db8::/32", "fc00::/7", "fe80::/10", "ff00::/8",
}

type peerPolicy struct{ deny, allow []*net.IPNet }

func parseNets(cidrs []string) ([]*net.IPNet, error) {
	nets := make([]*net.IPNet, 0, len(cidrs))
	for _, c := range cidrs {
		_, n, err := net.ParseCIDR(c)
		if err != nil {
			return nil, fmt.Errorf("bad CIDR %q: %w", c, err)
		}
		nets = append(nets, n)
	}
	return nets, nil
}

func newPeerPolicy(allow []string) (*peerPolicy, error) {
	deny, err := parseNets(deniedPeerRanges)
	if err != nil {
		return nil, err
	}
	allowNets, err := parseNets(allow)
	if err != nil {
		return nil, err
	}
	return &peerPolicy{deny: deny, allow: allowNets}, nil
}

func (p *peerPolicy) allows(ip net.IP) bool {
	if v4 := ip.To4(); v4 != nil {
		ip = v4
	}
	for _, n := range p.allow {
		if n.Contains(ip) {
			return true
		}
	}
	for _, n := range p.deny {
		if n.Contains(ip) {
			return false
		}
	}
	return true
}
