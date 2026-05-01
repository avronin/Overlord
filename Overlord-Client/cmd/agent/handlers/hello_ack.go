package handlers

import (
	"context"
	"log"
	"strings"

	pionwebrtc "github.com/pion/webrtc/v4"

	"overlord-client/cmd/agent/runtime"
	rtcbridge "overlord-client/cmd/agent/webrtc"
)

func HandleHelloAck(_ context.Context, env *runtime.Env, envelope map[string]interface{}) error {
	log.Printf("hello ack received")
	if env == nil || envelope == nil {
		return nil
	}

	var keywords []string
	minInterval := 0
	clipboardEnabled := false

	if raw, ok := envelope["notification"].(map[string]interface{}); ok {
		if rawKeywords, ok := raw["keywords"].([]interface{}); ok {
			for _, v := range rawKeywords {
				if s, ok := v.(string); ok {
					s = strings.TrimSpace(s)
					if s != "" {
						keywords = append(keywords, s)
					}
				}
			}
		}
		if v, ok := raw["minIntervalMs"].(float64); ok {
			minInterval = int(v)
		}
		if v, ok := raw["minIntervalMs"].(int); ok {
			minInterval = v
		}
		if v, ok := raw["clipboardEnabled"].(bool); ok {
			clipboardEnabled = v
		}
	}

	if len(keywords) > 0 || minInterval > 0 {
		env.SetNotificationConfig(keywords, minInterval, clipboardEnabled)
		log.Printf("hello ack: loaded %d notification keywords clipboard=%v", len(keywords), clipboardEnabled)
	}

	if rawICE, ok := envelope["iceServers"].([]interface{}); ok {
		servers := parseICEServers(rawICE)
		rtcbridge.SetICEServers(servers)
		log.Printf("hello ack: configured %d ICE server(s) for WebRTC", len(servers))
	}
	return nil
}

func parseICEServers(raw []interface{}) []pionwebrtc.ICEServer {
	out := make([]pionwebrtc.ICEServer, 0, len(raw))
	for _, item := range raw {
		entry, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		srv := pionwebrtc.ICEServer{}
		switch v := entry["urls"].(type) {
		case string:
			if v != "" {
				srv.URLs = []string{v}
			}
		case []interface{}:
			for _, u := range v {
				if s, ok := u.(string); ok && s != "" {
					srv.URLs = append(srv.URLs, s)
				}
			}
		}
		if len(srv.URLs) == 0 {
			continue
		}
		if u, ok := entry["username"].(string); ok {
			srv.Username = u
		}
		if c, ok := entry["credential"].(string); ok {
			srv.Credential = c
		}
		out = append(out, srv)
	}
	return out
}
