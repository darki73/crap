//go:build linux && cgo

// Disposable compatibility probe. This plugin is deliberately separate from the
// production affinity plugin and never reads or persists real credentials.
package main

/*
#include <stdint.h>
#include <stdlib.h>
typedef struct { void* ptr; size_t len; } buffer;
typedef int (*host_call)(void*, const char*, const uint8_t*, size_t, buffer*);
typedef void (*host_free)(void*, size_t);
typedef struct { uint32_t abi_version; void* host_ctx; host_call call; host_free free_buffer; } host_api;
typedef int (*plugin_call)(char*, uint8_t*, size_t, buffer*);
typedef void (*plugin_free)(void*, size_t);
typedef void (*plugin_shutdown)(void);
typedef struct { uint32_t abi_version; plugin_call call; plugin_free free_buffer; plugin_shutdown shutdown; } plugin_api;
extern int proofCall(char*, uint8_t*, size_t, buffer*);
extern void proofFree(void*, size_t);
extern void proofShutdown(void);
static int invoke(host_api* h, const char* m, uint8_t* r, size_t n, buffer* out) { return h->call(h->host_ctx,m,r,n,out); }
static void release(host_api* h, buffer b) { if (b.ptr) h->free_buffer(b.ptr,b.len); }
*/
import "C"

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"unsafe"
)

var host *C.host_api
var client = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

func main() {}

//export cliproxy_plugin_init
func cliproxy_plugin_init(h *C.host_api, api *C.plugin_api) C.int {
	if h == nil || api == nil || h.call == nil {
		return 1
	}
	host = h
	api.abi_version = 1
	api.call = C.plugin_call(C.proofCall)
	api.free_buffer = C.plugin_free(C.proofFree)
	api.shutdown = C.plugin_shutdown(C.proofShutdown)
	return 0
}

func call(method string, value, result any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	m := C.CString(method)
	defer C.free(unsafe.Pointer(m))
	p := C.CBytes(raw)
	defer C.free(p)
	var out C.buffer
	rc := C.invoke(host, m, (*C.uint8_t)(p), C.size_t(len(raw)), &out)
	defer C.release(host, out)
	if rc != 0 || out.len > 32<<20 {
		return errors.New("host callback failed")
	}
	var envelope struct {
		OK     bool            `json:"ok"`
		Result json.RawMessage `json:"result"`
	}
	if err := json.Unmarshal(C.GoBytes(out.ptr, C.int(out.len)), &envelope); err != nil {
		return err
	}
	if !envelope.OK {
		return errors.New("host execution rejected")
	}
	if result == nil {
		return nil
	}
	return json.Unmarshal(envelope.Result, result)
}

type execution struct {
	AuthID string `json:"auth_id"`
	Body   []byte `json:"body"`
	Stream bool   `json:"stream"`
	Fault  bool   `json:"fault"`
}

func relay(ctx context.Context, ticket string, frame any) error {
	raw, err := json.Marshal(frame)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, "POST", "http://boundary:8320/relay", bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+ticket)
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode != 204 {
		return errors.New("relay rejected")
	}
	return nil
}

func execute(raw []byte, streaming bool) (any, error) {
	var req struct {
		Headers      http.Header
		Callback     string `json:"host_callback_id"`
		OutputStream string `json:"stream_id"`
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return nil, err
	}
	ticket := req.Headers.Get("X-Crap-Execution")
	if ticket == "" || req.Callback == "" {
		return nil, errors.New("missing execution authorization")
	}
	claim, err := http.NewRequest("POST", "http://boundary:8320/claim", nil)
	if err != nil {
		return nil, err
	}
	claim.Header.Set("Authorization", "Bearer "+ticket)
	claimed, err := client.Do(claim)
	if err != nil {
		return nil, err
	}
	defer func() { _ = claimed.Body.Close() }()
	if claimed.StatusCode != 200 {
		return nil, errors.New("execution grant rejected")
	}
	var e execution
	if err := json.NewDecoder(claimed.Body).Decode(&e); err != nil {
		return nil, err
	}
	if e.AuthID == "" || e.Stream != streaming {
		return nil, errors.New("invalid grant")
	}
	if e.Fault {
		return nil, errors.New("injected plugin failure")
	}
	if err := relay(context.Background(), ticket, map[string]any{"kind": "admit", "auth_id": e.AuthID}); err != nil {
		return nil, err
	}
	args := map[string]any{
		"host_callback_id": req.Callback, "entry_protocol": "claude", "exit_protocol": "claude",
		"forced_provider": "claude", "model": "claude-fixture", "auth_id": e.AuthID,
		"stream": e.Stream, "body": e.Body, "path": "/v1/messages",
		"proxy_url": "http://execution:" + ticket + "@boundary:8321",
	}
	if !streaming {
		var response struct {
			Status  int         `json:"status_code"`
			Headers http.Header `json:"headers"`
			Body    []byte      `json:"body"`
		}
		if err := call("host.model.execute", args, &response); err != nil {
			return nil, err
		}
		return map[string]any{"Payload": response.Body, "Headers": response.Headers}, nil
	}
	if req.OutputStream == "" {
		return nil, errors.New("missing output stream")
	}
	var response struct {
		Headers http.Header `json:"headers"`
		ID      string      `json:"stream_id"`
	}
	if err := call("host.model.execute_stream", args, &response); err != nil {
		return nil, err
	}
	// The executor streaming ABI retains the host callback scope until output
	// closes. It also cancels nested model streams when the client disconnects.
	go func() {
		defer func() { _ = call("host.model.stream_close", map[string]any{"stream_id": response.ID}, nil) }()
		reason := ""
		defer func() {
			_ = call("host.stream.close", map[string]any{"stream_id": req.OutputStream, "error": reason}, nil)
		}()
		for {
			var chunk struct {
				Payload []byte `json:"payload"`
				Done    bool   `json:"done"`
				Error   string `json:"error"`
			}
			if err := call("host.model.stream_read", map[string]any{"stream_id": response.ID}, &chunk); err != nil {
				reason = "host stream failed"
				return
			}
			if chunk.Error != "" {
				reason = "host stream failed"
				return
			}
			if len(chunk.Payload) > 0 {
				if err := call("host.stream.emit", map[string]any{"stream_id": req.OutputStream, "payload": chunk.Payload}, nil); err != nil {
					return
				}
			}
			if chunk.Done {
				return
			}
		}
	}()
	return map[string]any{"headers": response.Headers}, nil
}

//export proofCall
func proofCall(method *C.char, request *C.uint8_t, length C.size_t, response *C.buffer) C.int {
	if method == nil || response == nil || length > 32<<20 {
		return 1
	}
	var result any = map[string]any{}
	var err error
	switch name := C.GoString(method); name {
	case "plugin.register", "plugin.reconfigure":
		result = map[string]any{"schema_version": 6, "metadata": map[string]any{"Name": "Disposable CRAP routing proof", "Version": "0.0.1", "Author": "CRAP compatibility fixture", "GitHubRepository": "Unpublished disposable CRAP fixture"}, "capabilities": map[string]any{"model_router": true, "executor": true, "executor_model_scope": "static", "executor_input_formats": []string{"claude"}, "executor_output_formats": []string{"claude"}}}
	case "model.route":
		var route struct {
			RequestedModel string
			Headers        http.Header
		}
		err = json.Unmarshal(C.GoBytes(unsafe.Pointer(request), C.int(length)), &route)
		result = map[string]any{"Handled": route.RequestedModel == "crap-strict-proof" && route.Headers.Get("X-Proof-Skip") != "true", "TargetKind": "self"}
	case "executor.identifier":
		result = map[string]any{"Identifier": "strict-proof"}
	case "executor.execute", "executor.execute_stream":
		result, err = execute(C.GoBytes(unsafe.Pointer(request), C.int(length)), name == "executor.execute_stream")
	case "plugin.quiesce", "plugin.shutdown":
		result = map[string]any{}
	default:
		err = fmt.Errorf("unsupported proof method: %s", name)
	}
	envelope := map[string]any{"ok": true, "result": result}
	if err != nil {
		envelope = map[string]any{"ok": false, "error": map[string]any{"code": "proof_rejected", "message": err.Error()}}
	}
	raw, err := json.Marshal(envelope)
	if err != nil {
		return 1
	}
	response.ptr = C.CBytes(raw)
	response.len = C.size_t(len(raw))
	return 0
}

//export proofFree
func proofFree(ptr unsafe.Pointer, _ C.size_t) {
	if ptr != nil {
		C.free(ptr)
	}
}

//export proofShutdown
func proofShutdown() {}
