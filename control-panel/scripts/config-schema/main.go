// Command config-schema generates the panel's form schema from this checkout.
// Run from the repository root: go run ./control-panel/scripts/config-schema
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"reflect"
	"strings"
	"time"

	"github.com/router-for-me/CLIProxyAPI/v8/internal/config"
	"gopkg.in/yaml.v3"
)

type schema struct {
	Kind        string             `json:"kind"`
	Default     any                `json:"default"`
	Description string             `json:"description,omitempty"`
	Properties  map[string]*schema `json:"properties,omitempty"`
	Item        *schema            `json:"item,omitempty"`
	Additional  *schema            `json:"additional,omitempty"`
}

var comments = map[string]string{}

func main() {
	if err := generate(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func generate() error {
	packages, err := parser.ParseDir(token.NewFileSet(), "internal/config", nil, parser.ParseComments)
	if err != nil {
		return err
	}
	for _, file := range packages["config"].Files {
		ast.Inspect(file, func(node ast.Node) bool {
			t, ok := node.(*ast.TypeSpec)
			if !ok {
				return true
			}
			s, ok := t.Type.(*ast.StructType)
			if !ok {
				return true
			}
			for _, field := range s.Fields.List {
				for _, name := range field.Names {
					comments[t.Name.Name+"."+name.Name] = strings.TrimSpace(field.Doc.Text())
				}
			}
			return false
		})
	}
	defaults, err := config.ParseConfigBytes([]byte("{}"))
	if err != nil {
		return err
	}
	legacy := describe(reflect.TypeOf(*defaults), reflect.ValueOf(*defaults))
	root := &schema{Kind: "object", Properties: map[string]*schema{}}
	families := map[string]string{"gemini-api-key": "gemini", "interactions-api-key": "interactions", "vertex-api-key": "vertex", "codex-api-key": "codex", "claude-api-key": "claude", "xai-api-key": "xai", "meta-api-key": "meta", "openai-compatibility": "openai-compatibility"}
	var walk func(*schema, []string) error
	walk = func(s *schema, path []string) error {
		if s.Kind == "object" && s.Additional == nil {
			for key, child := range s.Properties {
				if errWalk := walk(child, append(append([]string{}, path...), key)); errWalk != nil {
					return errWalk
				}
			}
			return nil
		}
		if len(path) == 1 {
			if _, ok := families[path[0]]; ok {
				return nil
			}
		}
		// Let the server's canonical migration code resolve every field's v8 path.
		var value any = "__panel_schema_leaf__"
		for i := len(path) - 1; i >= 0; i-- {
			value = map[string]any{path[i]: value}
		}
		encoded, errEncode := yaml.Marshal(value)
		if errEncode != nil {
			return errEncode
		}
		canonical, _, errNormalize := config.NormalizeConfigLayout(encoded, true)
		if errNormalize != nil {
			return errNormalize
		}
		var decoded map[string]any
		if errDecode := yaml.Unmarshal(canonical, &decoded); errDecode != nil {
			return errDecode
		}
		var find func(any, []string) []string
		find = func(v any, p []string) []string {
			if v == "__panel_schema_leaf__" {
				return p
			}
			if m, ok := v.(map[string]any); ok {
				for key, child := range m {
					if found := find(child, append(append([]string{}, p...), key)); found != nil {
						return found
					}
				}
			}
			return nil
		}
		resolved := find(decoded, nil)
		if resolved == nil {
			return fmt.Errorf("no v8 schema path for %s", strings.Join(path, "."))
		}
		put(root, resolved, s)
		return nil
	}
	if errWalk := walk(legacy, nil); errWalk != nil {
		return errWalk
	}
	for old, family := range families {
		item := legacy.Properties[old].Item
		group := &schema{Kind: "object", Properties: map[string]*schema{}}
		if family == "openai-compatibility" {
			for key, field := range item.Properties {
				if key == "api-key-entries" {
					key = "keys"
				}
				group.Properties[key] = field
			}
		} else {
			group.Properties["name"] = &schema{Kind: "string", Default: ""}
			keyFields := map[string]*schema{}
			for key, field := range item.Properties {
				if key == "base-url" || strings.Contains("|priority|prefix|proxy-url|headers|models|excluded-models|disable-cooling|request-retry|request-scoped-errors|", "|"+key+"|") {
					group.Properties[key] = field
				}
				if key != "base-url" {
					keyFields[key] = field
				}
			}
			group.Properties["keys"] = &schema{Kind: "array", Default: []any{}, Item: &schema{Kind: "object", Properties: keyFields}}
		}
		put(root, []string{"api-keys", family}, &schema{Kind: "array", Default: []any{}, Item: group})
	}
	data, errJSON := json.MarshalIndent(root, "", "  ")
	if errJSON != nil {
		return errJSON
	}
	return os.WriteFile("control-panel/src/lib/config-schema.json", append(data, '\n'), 0644)
}

func put(root *schema, path []string, value *schema) {
	for _, part := range path[:len(path)-1] {
		if root.Properties[part] == nil {
			root.Properties[part] = &schema{Kind: "object", Properties: map[string]*schema{}}
		}
		root = root.Properties[part]
	}
	root.Properties[path[len(path)-1]] = value
}

func describe(t reflect.Type, v reflect.Value) *schema {
	nilPointer := false
	if t.Kind() == reflect.Pointer {
		t = t.Elem()
		if v.IsNil() {
			nilPointer = true
			v = reflect.Zero(t)
		} else {
			v = v.Elem()
		}
	}
	s := &schema{}
	if t == reflect.TypeOf(time.Duration(0)) {
		s.Kind = "string"
		s.Default = time.Duration(v.Int()).String()
		return s
	}
	switch t.Kind() {
	case reflect.Struct:
		s.Kind = "object"
		s.Properties = map[string]*schema{}
		for i := 0; i < t.NumField(); i++ {
			f := t.Field(i)
			tag := strings.Split(f.Tag.Get("yaml"), ",")[0]
			if f.PkgPath != "" || tag == "-" {
				continue
			}
			child := describe(f.Type, v.Field(i))
			child.Description = comments[t.Name()+"."+f.Name]
			if f.Anonymous {
				for key, field := range child.Properties {
					s.Properties[key] = field
				}
			} else {
				s.Properties[tag] = child
			}
		}
		if t.Name() == "PluginInstanceConfig" {
			s.Additional = &schema{Kind: "any"}
		}
	case reflect.Map:
		s.Kind = "object"
		s.Default = map[string]any{}
		s.Additional = describe(t.Elem(), reflect.Zero(t.Elem()))
	case reflect.Slice, reflect.Array:
		s.Kind = "array"
		s.Default = []any{}
		s.Item = describe(t.Elem(), reflect.Zero(t.Elem()))
		if v.Len() > 0 {
			s.Default = v.Interface()
		}
	case reflect.Bool:
		s.Kind = "boolean"
		s.Default = v.Bool()
	case reflect.String:
		s.Kind = "string"
		s.Default = v.String()
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		s.Kind = "number"
		s.Default = v.Int()
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		s.Kind = "number"
		s.Default = v.Uint()
	case reflect.Float32, reflect.Float64:
		s.Kind = "number"
		s.Default = v.Float()
	default:
		s.Kind = "any"
	}
	if nilPointer {
		s.Default = nil
	}
	if t.Name() == "DisableImageGenerationMode" {
		s.Kind = "image-mode"
		s.Default = false
	}
	return s
}
