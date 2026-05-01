package webrtc

import (
	"context"
	"log"
	"sync"
	"sync/atomic"

	pionwebrtc "github.com/pion/webrtc/v4"

	"overlord-client/cmd/agent/wire"
)

type peerKey = string

var (
	mu    sync.Mutex
	peers = map[peerKey]*Peer{}

	iceServers atomic.Value // []pionwebrtc.ICEServer

	onKeyframeRequest atomic.Value // func()
	onCommandEnvelope atomic.Value // func(envelope map[string]any)

	broadcastSamples atomic.Int64
)

func SetICEServers(servers []pionwebrtc.ICEServer) {
	if servers == nil {
		servers = []pionwebrtc.ICEServer{}
	}
	iceServers.Store(servers)
}

func getICEServers() []pionwebrtc.ICEServer {
	if v, ok := iceServers.Load().([]pionwebrtc.ICEServer); ok && v != nil {
		return v
	}
	return []pionwebrtc.ICEServer{{URLs: []string{"stun:stun.l.google.com:19302"}}}
}

func SetKeyframeHandler(fn func()) {
	if fn == nil {
		return
	}
	onKeyframeRequest.Store(fn)
}

func SetCommandHandler(fn func(envelope map[string]any)) {
	if fn == nil {
		return
	}
	onCommandEnvelope.Store(fn)
}

func fireKeyframeRequest() {
	if fn, ok := onKeyframeRequest.Load().(func()); ok && fn != nil {
		fn()
	}
}

func dispatchCommand(envelope map[string]any) {
	if fn, ok := onCommandEnvelope.Load().(func(map[string]any)); ok && fn != nil {
		fn(envelope)
	}
}

func HandleOffer(ctx context.Context, conn wire.Writer, sessionID string, sdp string) error {
	if sessionID == "" {
		return errEmptySession
	}
	closePeerLocked(sessionID)

	mu.Lock()
	peer, err := newPeer(sessionID, conn, getICEServers())
	if err != nil {
		mu.Unlock()
		return err
	}
	peers[sessionID] = peer
	mu.Unlock()

	if err := peer.applyOffer(ctx, sdp); err != nil {
		ClosePeer(sessionID)
		return err
	}
	return nil
}

func HandleICECandidate(sessionID, candidate, sdpMid string, sdpMLineIndex uint16) error {
	mu.Lock()
	peer := peers[sessionID]
	mu.Unlock()
	if peer == nil {
		return nil
	}
	return peer.addRemoteICE(candidate, sdpMid, sdpMLineIndex)
}

func ClosePeer(sessionID string) {
	closePeerLocked(sessionID)
}

func closePeerLocked(sessionID string) {
	mu.Lock()
	peer := peers[sessionID]
	delete(peers, sessionID)
	mu.Unlock()
	if peer != nil {
		peer.close()
	}
}

func CloseAll() {
	mu.Lock()
	snap := peers
	peers = map[peerKey]*Peer{}
	mu.Unlock()
	for _, p := range snap {
		p.close()
	}
}

func ActivePeerCount() int {
	mu.Lock()
	defer mu.Unlock()
	return len(peers)
}

func BroadcastH264(annexB []byte, durationNs int64) {
	if len(annexB) == 0 {
		return
	}
	mu.Lock()
	if len(peers) == 0 {
		mu.Unlock()
		return
	}
	snap := make([]*Peer, 0, len(peers))
	for _, p := range peers {
		snap = append(snap, p)
	}
	mu.Unlock()

	for _, p := range snap {
		if err := p.writeH264(annexB, durationNs); err != nil {
			n := broadcastSamples.Add(1)
			if n%200 == 1 {
				log.Printf("webrtc: writeH264 failed (session=%s): %v", p.sessionID, err)
			}
		}
	}
}
