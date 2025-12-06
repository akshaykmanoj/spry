---
docFM:
  key1: "valueFromENV: ${env.KEY1}"
  key2: "scalar"
---

# Intro

This notebook shows how cells, partials, and injections work together.

## Code nodes

This is an actionable (executable) code node with a name `init`.

```bash init
echo "init script"
```

This is an actionable (executable) code node with a name `prime`.

```env prime
KEY=VALUE
```

This is a declaration directive node with nature `META` but no identifier or
name. There's nothing special about the token `META` in the Spry library but the
test case treats it as special.

```yaml META
key1: value1
key2: value2
```

This is a directive node with nature `HEAD` but no identifier or name.

```text HEAD
This is the first HEAD node and has no identifier so
one will be assigned by default.
```

```markdown HEAD "head.md"
# This is the second HEAD node and has an identifier.
```

These are materializable nodes with identifiers. `--interpolate` and `-I` both
have the same meaning. But, they are interpolatable by default anyway.
Executables are NOT interpolated by default, but Materializables are.

```text path1/name.txt --interpolate
This text will be interpolated: ${unsafeEval("2 + 4")} = 6;
-- also test nested expression: ${`${unsafeEval("3 + 3")}`} = 6
```

```text admin/name.txt -I
This text will be interpolated but will result in no mutations though it will
get injections from the global PARTIAL.
```

```md admin/name.md -C sampleCap1
This text will be interpolated: **${unsafeEval("2 + 3")}** = 5;

- [ ] confirm locals are visible: site = ${siteName}
```

This is a named PARTIAL directive that uses type-safe locals.

```md PARTIAL greet-user { userName: { type: "string", required: true }, mood: { type: "string" } }
# PARTIAL greet-user

- path: ${identity}
- userName: ${userName}
- mood: $!{mood ?? "undefined"}
```

This cell uses the partial from within a normal page.

```text admin/home.txt { route: { caption: "Admin Home" } }
admin home page
path: ${SELF.materializableIdentity} via SELF
path: ${identity} passed in
route caption: ${route.caption} coming from code attrs

direct call with await
${await partial("greet-user", { userName: "Zoya", mood: "cheerful" })}

call without await (should still work, but output may show a Promise)
${partial("greet-user", { userName: "Zoya (no await)" })}
```

The following partial acts as a global layout and will be injected for all pages
unless a more specific layout overrides it.

```md PARTIAL global-layout --inject **/*
# global layout (injected for any path)
```

The following partial is injected only for admin paths and overrides the global
layout when it matches.

```md PARTIAL admin-layout --inject admin/**
## admin layout (injected for any admin/* paths)
```

A debug cell that exercises helpers and error behavior.

Note that "simple" text expressions and pre-registered functions use `${...}`
while calling a PARTIAL is done using `{{...}}`. The full "unsafe" JS eval is
available with `$!{...}`.

```text debug.txt
markdown link: ${mdLink("demo", "https://example.com")} (comes from "safeFunctions")
siteName: ${siteName} (comes from "globals")

- missing partial:
{{non-existent}}

- greet-user with wrong args:
{{ greet-user { wrongName: "oops" } }}

- greet-user with correct args:
{{ greet-user { userName: "Debug User", mood: "alert" } }}

- greet-user with correct args using unsafe interpolator:
$!{await partial("greet-user", { wrongName: "oops" })}
$!{await partial("greet-user", { userName: "Zoya", mood: "cheerful" })}

- full ctx (unsafe):
$!{safeJsonStringify(ctx)}

- captured/memoized (synonyms):
-----
${captured.sampleCap1}
-----

====
${memoized.sampleCap1}
====
```

## Outro

```text TAIL
DONE!
```
