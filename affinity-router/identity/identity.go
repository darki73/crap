// Package identity creates namespaced references without persisting raw identities.
package identity

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
)

// Reference binds an ID to both tenant and purpose. The shared key must be a
// stable secret of at least 32 random bytes, kept outside the database. Rotating
// it changes references and therefore requires an explicit migration strategy.
func Reference(key []byte, tenant, purpose, raw string) (string, error) {
	if len(key) < 32 || tenant == "" || purpose == "" || raw == "" {
		return "", errors.New("identity requires a 32-byte key and nonempty tenant, purpose and value")
	}
	encoded, errMarshal := json.Marshal([]string{"v1", tenant, purpose, raw})
	if errMarshal != nil {
		return "", errMarshal
	}
	mac := hmac.New(sha256.New, key)
	_, _ = mac.Write(encoded)
	return "v1:" + hex.EncodeToString(mac.Sum(nil)), nil
}
