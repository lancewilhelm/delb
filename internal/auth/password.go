package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"strings"

	"golang.org/x/crypto/scrypt"
	"golang.org/x/text/unicode/norm"
)

// Better Auth scrypt parameters (from @better-auth/utils/dist/password.node.cjs):
//   N = 16384, r = 16, p = 1, dkLen = 64
//   salt = 16 random bytes encoded as 32 lowercase hex chars, passed as UTF-8 bytes
//   password = Unicode NFKC normalized before scrypt
//   output = "<32-hex-salt>:<128-hex-key>" (161 chars)
const (
	scryptN      = 16384
	scryptR      = 16
	scryptP      = 1
	scryptKeyLen = 64
	saltRawBytes = 16
)

// HashPassword hashes a plaintext password in Better Auth's exact scrypt format.
func HashPassword(password string) (string, error) {
	saltBytes := make([]byte, saltRawBytes)
	if _, err := rand.Read(saltBytes); err != nil {
		return "", fmt.Errorf("generate password salt: %w", err)
	}
	saltHex := hex.EncodeToString(saltBytes)
	derived, err := deriveKey(password, saltHex, scryptKeyLen)
	if err != nil {
		return "", err
	}
	return saltHex + ":" + hex.EncodeToString(derived), nil
}

// VerifyPassword verifies a plaintext password against a Better Auth scrypt hash.
func VerifyPassword(storedHash, password string) (bool, error) {
	parts := strings.Split(storedHash, ":")
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return false, fmt.Errorf("invalid password hash format")
	}
	saltHex, expectedHex := parts[0], parts[1]
	expectedBytes, err := hex.DecodeString(expectedHex)
	if err != nil || len(expectedBytes) == 0 {
		return false, fmt.Errorf("invalid password hash encoding")
	}
	derived, err := deriveKey(password, saltHex, len(expectedBytes))
	if err != nil {
		return false, err
	}
	return subtle.ConstantTimeCompare(derived, expectedBytes) == 1, nil
}

func deriveKey(password, saltHex string, keyLen int) ([]byte, error) {
	normalized := norm.NFKC.String(password)
	key, err := scrypt.Key([]byte(normalized), []byte(saltHex), scryptN, scryptR, scryptP, keyLen)
	if err != nil {
		return nil, fmt.Errorf("scrypt key derivation: %w", err)
	}
	return key, nil
}
