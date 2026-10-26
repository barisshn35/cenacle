// SPDX-License-Identifier: AGPL-3.0-only

package httpx

import (
	"reflect"
	"strings"
)

// HasNUL reports whether any string in v (a decoded request body: structs,
// pointers, slices, maps and their keys) holds the NUL character, which
// PostgreSQL does not store in text.
func HasNUL(v any) bool {
	return hasNUL(reflect.ValueOf(v), 0)
}

func hasNUL(v reflect.Value, depth int) bool {
	if depth > 32 || !v.IsValid() {
		return false
	}
	switch v.Kind() {
	case reflect.String:
		return strings.IndexByte(v.String(), 0) >= 0
	case reflect.Pointer, reflect.Interface:
		return !v.IsNil() && hasNUL(v.Elem(), depth+1)
	case reflect.Struct:
		for i := range v.NumField() {
			if v.Type().Field(i).IsExported() && hasNUL(v.Field(i), depth+1) {
				return true
			}
		}
	case reflect.Slice, reflect.Array:
		if v.Type().Elem().Kind() == reflect.Uint8 {
			return false // bytes, not text
		}
		for i := range v.Len() {
			if hasNUL(v.Index(i), depth+1) {
				return true
			}
		}
	case reflect.Map:
		iter := v.MapRange()
		for iter.Next() {
			if hasNUL(iter.Key(), depth+1) || hasNUL(iter.Value(), depth+1) {
				return true
			}
		}
	}
	return false
}
