//go:build linux && cgo

package main

/*
#include <stdint.h>
#include <stdlib.h>
typedef struct { void* ptr; size_t len; } cliproxy_buffer;
typedef int (*host_call_fn)(void*,const char*,const uint8_t*,size_t,cliproxy_buffer*);
typedef void (*host_free_fn)(void*,size_t);
typedef struct { uint32_t abi_version; void* host_ctx; host_call_fn call; host_free_fn free_buffer; } cliproxy_host_api;
static int invoke_host(cliproxy_host_api* h,const char* m,uint8_t* r,size_t n,cliproxy_buffer* out){return h->call(h->host_ctx,m,r,n,out);}
static void release_host(cliproxy_host_api* h,cliproxy_buffer b){if(b.ptr)h->free_buffer(b.ptr,b.len);}
typedef int (*cliproxy_plugin_call_fn)(char*, uint8_t*, size_t, cliproxy_buffer*);
typedef void (*cliproxy_plugin_free_fn)(void*, size_t);
typedef void (*cliproxy_plugin_shutdown_fn)(void);
typedef struct {uint32_t abi_version;cliproxy_plugin_call_fn call;cliproxy_plugin_free_fn free_buffer;cliproxy_plugin_shutdown_fn shutdown;} cliproxy_plugin_api;
extern int cliproxyPluginCall(char*,uint8_t*,size_t,cliproxy_buffer*);
extern void cliproxyPluginFree(void*,size_t);
extern void cliproxyPluginShutdown(void);
*/
import "C"

import (
	"cliproxy-affinity-router/plugin"
	"encoding/json"
	"sync"
	"unsafe"
)

var mu sync.Mutex
var runtime *plugin.Runtime
var hostAPI *C.cliproxy_host_api

func main() {}

//export cliproxy_plugin_init
func cliproxy_plugin_init(host *C.cliproxy_host_api, api *C.cliproxy_plugin_api) C.int {
	if api == nil || host == nil {
		return 1
	}
	hostAPI = host
	api.abi_version = 1
	api.call = C.cliproxy_plugin_call_fn(C.cliproxyPluginCall)
	api.free_buffer = C.cliproxy_plugin_free_fn(C.cliproxyPluginFree)
	api.shutdown = C.cliproxy_plugin_shutdown_fn(C.cliproxyPluginShutdown)
	return 0
}

//export cliproxyPluginCall
func cliproxyPluginCall(method *C.char, request *C.uint8_t, length C.size_t, response *C.cliproxy_buffer) C.int {
	if response == nil {
		return 1
	}
	response.ptr = nil
	response.len = 0
	if method == nil || length > 32<<20 {
		return 1
	}
	name := C.GoString(method)
	var raw []byte
	if request != nil && length > 0 {
		raw = C.GoBytes(unsafe.Pointer(request), C.int(length))
	}
	var value any
	var err error
	mu.Lock()
	if name == "plugin.register" || name == "plugin.reconfigure" {
		if runtime == nil {
			runtime, err = plugin.New()
			if err == nil {
				runtime.Host = callHost
			}
		}
		if runtime != nil {
			runtime.Resume()
		}
		value = plugin.Registration()
	}
	r := runtime
	mu.Unlock()
	if name != "plugin.register" && name != "plugin.reconfigure" {
		if r == nil {
			return 1
		}
		value, err = r.Handle(name, raw)
	}
	envelope := map[string]any{"ok": true, "result": value}
	if err != nil {
		envelope = map[string]any{"ok": false, "error": map[string]any{"code": "affinity_error", "message": "Routing operation failed; no automatic retry was made"}}
	}
	if failure, ok := err.(*plugin.ExecutionError); ok {
		envelope = map[string]any{"ok": false, "error": map[string]any{"code": failure.Code, "message": failure.Message, "http_status": failure.Status}}
	}
	encoded, errEncode := json.Marshal(envelope)
	if errEncode != nil {
		return 1
	}
	response.ptr = C.CBytes(encoded)
	response.len = C.size_t(len(encoded))
	return 0
}

//export cliproxyPluginFree
func cliproxyPluginFree(ptr unsafe.Pointer, _ C.size_t) {
	if ptr != nil {
		C.free(ptr)
	}
}

//export cliproxyPluginShutdown
func cliproxyPluginShutdown() {
	mu.Lock()
	defer mu.Unlock()
	if runtime != nil {
		runtime.Close()
		runtime = nil
	}
}

func callHost(method string, value, out any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	name := C.CString(method)
	defer C.free(unsafe.Pointer(name))
	data := C.CBytes(raw)
	defer C.free(data)
	var response C.cliproxy_buffer
	rc := C.invoke_host(hostAPI, name, (*C.uint8_t)(data), C.size_t(len(raw)), &response)
	defer C.release_host(hostAPI, response)
	if rc != 0 || response.len > 64<<20 {
		return &plugin.ExecutionError{Status: 503, Code: "crap_host_unavailable", Message: "Proxy execution callback unavailable"}
	}
	var envelope struct {
		OK     bool            `json:"ok"`
		Result json.RawMessage `json:"result"`
		Error  struct {
			Code    string `json:"code"`
			Message string `json:"message"`
			Status  int    `json:"http_status"`
		} `json:"error"`
	}
	if err = json.Unmarshal(C.GoBytes(response.ptr, C.int(response.len)), &envelope); err != nil {
		return err
	}
	if !envelope.OK {
		status := envelope.Error.Status
		if status < 400 {
			status = 502
		}
		return &plugin.ExecutionError{Status: status, Code: "crap_upstream_error", Message: envelope.Error.Message}
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(envelope.Result, out)
}
