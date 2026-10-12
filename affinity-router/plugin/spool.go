package plugin

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

const defaultSpoolBytes = 64 << 20
const defaultSpoolFiles = 10000

// Limits stop NEW work. Callbacks for already admitted work are always retained,
// even when they push the queue beyond the admission threshold.
func (r *Runtime) spoolHealth() error {
	r.spoolMu.Lock()
	defer r.spoolMu.Unlock()
	maxBytes, maxFiles := r.SpoolMaxBytes, r.SpoolMaxFiles
	if maxBytes <= 0 {
		maxBytes = defaultSpoolBytes
	}
	if maxFiles <= 0 {
		maxFiles = defaultSpoolFiles
	}
	files, err := os.ReadDir(r.Spool)
	if err != nil {
		return err
	}
	var total int64
	for _, file := range files {
		if strings.HasSuffix(file.Name(), ".rejected") {
			return errors.New("rejected spool event requires inspection")
		}
		info, err := file.Info()
		if err != nil {
			return err
		}
		total += info.Size()
	}
	if len(files) >= maxFiles || total >= maxBytes {
		return errors.New("spool admission threshold reached")
	}
	// Verify persistence before admitting another request, including on an empty
	// queue after a filesystem outage. The probe never contains client data.
	file, err := os.CreateTemp(r.Spool, "probe-*")
	if err != nil {
		return err
	}
	name := file.Name()
	err = file.Sync()
	errClose := file.Close()
	errRemove := os.Remove(name)
	if err != nil {
		return err
	}
	if errClose != nil {
		return errClose
	}
	return errRemove
}

func syncDirectory(path string) error {
	// Windows file handles do not support fsync on directories.
	if runtime.GOOS == "windows" {
		return nil
	}
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	defer func() { _ = dir.Close() }()
	return dir.Sync()
}

func (r *Runtime) recoverSpool() error {
	files, err := os.ReadDir(r.Spool)
	if err != nil {
		return err
	}
	for _, file := range files {
		name := file.Name()
		if strings.HasPrefix(name, "probe-") {
			if err = os.Remove(filepath.Join(r.Spool, name)); err != nil {
				return err
			}
			continue
		}
		if !strings.HasPrefix(name, "pending-") || !strings.HasSuffix(name, ".tmp") {
			continue
		}
		path := filepath.Join(r.Spool, name)
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		var q queued
		destination := strings.TrimSuffix(path, ".tmp") + ".json"
		if json.Unmarshal(raw, &q) != nil || !json.Valid(q.Body) || (q.Path != "/usage" && q.Path != "/journal" && q.Path != "/cache-observations") {
			destination = path + ".rejected"
		}
		if _, err := os.Stat(destination); !os.IsNotExist(err) {
			return errors.New("spool recovery collision")
		}
		if err = os.Rename(path, destination); err != nil {
			return err
		}
	}
	return syncDirectory(r.Spool)
}
