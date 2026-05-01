package webrtc

import (
	"context"
	"errors"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/rtcp"
	pionwebrtc "github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
	"github.com/vmihailenco/msgpack/v5"

	"overlord-client/cmd/agent/wire"
)

var errEmptySession = errors.New("webrtc: empty session id")

type Peer struct {
	sessionID string
	signaler  wire.Writer
	pc        *pionwebrtc.PeerConnection
	video     *pionwebrtc.TrackLocalStaticSample

	inputMu sync.Mutex
	input   *pionwebrtc.DataChannel

	closed atomic.Bool
}

func newPeer(sessionID string, signaler wire.Writer, iceServers []pionwebrtc.ICEServer) (*Peer, error) {
	cfg := pionwebrtc.Configuration{
		ICEServers:         iceServers,
		ICETransportPolicy: pionwebrtc.ICETransportPolicyRelay,
		BundlePolicy:       pionwebrtc.BundlePolicyMaxBundle,
	}

	me := &pionwebrtc.MediaEngine{}
	if err := me.RegisterCodec(pionwebrtc.RTPCodecParameters{
		RTPCodecCapability: pionwebrtc.RTPCodecCapability{
			MimeType:    pionwebrtc.MimeTypeH264,
			ClockRate:   90000,
			SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
		},
		PayloadType: 102,
	}, pionwebrtc.RTPCodecTypeVideo); err != nil {
		return nil, err
	}

	api := pionwebrtc.NewAPI(pionwebrtc.WithMediaEngine(me))

	pc, err := api.NewPeerConnection(cfg)
	if err != nil {
		return nil, err
	}

	video, err := pionwebrtc.NewTrackLocalStaticSample(
		pionwebrtc.RTPCodecCapability{MimeType: pionwebrtc.MimeTypeH264},
		"video", "overlord-rd-"+sessionID,
	)
	if err != nil {
		_ = pc.Close()
		return nil, err
	}

	sender, err := pc.AddTrack(video)
	if err != nil {
		_ = pc.Close()
		return nil, err
	}

	p := &Peer{
		sessionID: sessionID,
		signaler:  signaler,
		pc:        pc,
		video:     video,
	}

	go p.rtcpLoop(sender)

	pc.OnICECandidate(p.onLocalICECandidate)
	pc.OnDataChannel(p.onDataChannel)
	pc.OnConnectionStateChange(p.onConnectionStateChange)

	return p, nil
}

func (p *Peer) applyOffer(ctx context.Context, sdp string) error {
	if err := p.pc.SetRemoteDescription(pionwebrtc.SessionDescription{
		Type: pionwebrtc.SDPTypeOffer,
		SDP:  sdp,
	}); err != nil {
		return err
	}

	answer, err := p.pc.CreateAnswer(nil)
	if err != nil {
		return err
	}
	if err := p.pc.SetLocalDescription(answer); err != nil {
		return err
	}

	local := p.pc.LocalDescription()
	if local == nil {
		return errors.New("webrtc: no local description after answer")
	}

	return p.sendSignal(ctx, map[string]any{
		"type":      "rtc_answer",
		"sessionId": p.sessionID,
		"sdp":       local.SDP,
	})
}

func (p *Peer) addRemoteICE(candidate, sdpMid string, sdpMLineIndex uint16) error {
	mid := sdpMid
	idx := sdpMLineIndex
	init := pionwebrtc.ICECandidateInit{
		Candidate:     candidate,
		SDPMid:        &mid,
		SDPMLineIndex: &idx,
	}
	return p.pc.AddICECandidate(init)
}

func (p *Peer) onLocalICECandidate(c *pionwebrtc.ICECandidate) {
	if c == nil {
		return
	}
	init := c.ToJSON()
	mid := ""
	if init.SDPMid != nil {
		mid = *init.SDPMid
	}
	var idx uint16
	if init.SDPMLineIndex != nil {
		idx = *init.SDPMLineIndex
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = p.sendSignal(ctx, map[string]any{
		"type":          "rtc_ice",
		"sessionId":     p.sessionID,
		"candidate":     init.Candidate,
		"sdpMid":        mid,
		"sdpMLineIndex": idx,
	})
}

func (p *Peer) onDataChannel(dc *pionwebrtc.DataChannel) {
	if dc.Label() != "input" {
		return
	}
	p.inputMu.Lock()
	p.input = dc
	p.inputMu.Unlock()

	dc.OnMessage(func(msg pionwebrtc.DataChannelMessage) {
		if msg.IsString {
			return
		}
		envelope := map[string]any{}
		if err := msgpack.Unmarshal(msg.Data, &envelope); err != nil {
			return
		}
		if t, _ := envelope["type"].(string); t == "" {
			if _, hasCmd := envelope["commandType"]; hasCmd {
				envelope["type"] = "command"
			}
		}
		dispatchCommand(envelope)
	})
}

func (p *Peer) onConnectionStateChange(state pionwebrtc.PeerConnectionState) {
	switch state {
	case pionwebrtc.PeerConnectionStateConnected:
		log.Printf("webrtc: peer %s connected", p.sessionID)
	case pionwebrtc.PeerConnectionStateFailed,
		pionwebrtc.PeerConnectionStateDisconnected,
		pionwebrtc.PeerConnectionStateClosed:
		log.Printf("webrtc: peer %s state=%s — closing", p.sessionID, state)
		go ClosePeer(p.sessionID)
	}
}

func (p *Peer) rtcpLoop(sender *pionwebrtc.RTPSender) {
	buf := make([]byte, 1500)
	for {
		if p.closed.Load() {
			return
		}
		n, _, err := sender.Read(buf)
		if err != nil {
			return
		}
		pkts, err := rtcp.Unmarshal(buf[:n])
		if err != nil {
			continue
		}
		for _, pkt := range pkts {
			switch pkt.(type) {
			case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
				fireKeyframeRequest()
			}
		}
	}
}

func (p *Peer) writeH264(annexB []byte, durationNs int64) error {
	if p.closed.Load() {
		return nil
	}
	dur := time.Duration(durationNs)
	if dur <= 0 {
		dur = time.Second / 30
	}
	return p.video.WriteSample(media.Sample{
		Data:     annexB,
		Duration: dur,
	})
}

func (p *Peer) sendSignal(ctx context.Context, payload map[string]any) error {
	if p.signaler == nil {
		return errors.New("webrtc: nil signaler")
	}
	return wire.WriteMsg(ctx, p.signaler, payload)
}

func (p *Peer) close() {
	if !p.closed.CompareAndSwap(false, true) {
		return
	}
	p.inputMu.Lock()
	if p.input != nil {
		_ = p.input.Close()
		p.input = nil
	}
	p.inputMu.Unlock()
	if p.pc != nil {
		_ = p.pc.Close()
	}
}
