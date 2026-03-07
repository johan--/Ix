# Symbol-Level Extraction Design

**Date:** 2026-03-07
**Goal:** Evolve Ix from file/blob-centric retrieval toward symbol-centric scene-graph retrieval while preserving the current parser architecture.

**Approach:** Enhance existing regex parsers + query/search layer. No tree-sitter. No parser rewrites.

---

## 1. New NodeKinds

Add 4 cases to `sealed trait NodeKind` in `Node.scala`:

- **Object** — Scala objects (companion objects, singletons)
- **Trait** — Scala traits
- **Interface** — TypeScript interfaces
- **Method** — Class/object/trait methods (vs top-level `Function`)

### Mapping Rules

| Language | Construct | NodeKind |
|----------|-----------|----------|
| Scala | `trait Foo` | Trait |
| Scala | `object Foo` | Object |
| Scala | `class Foo` / `case class Foo` | Class |
| Scala | `def bar` inside container | Method |
| Scala | `def bar` top-level | Function |
| TypeScript | `interface Foo` | Interface |
| TypeScript | `class Foo` | Class |
| TypeScript | method inside class | Method |
| TypeScript | top-level function/arrow | Function |

---

## 2. Parser Enhancements

### ScalaParser

- Use `Trait` kind for trait matches (was `Class`)
- Use `Object` kind for object matches (was `Class`)
- Use `Method` for def inside a container, `Function` for top-level def
- Add `signature` attr — capture the def line up to `=` or `{`
- Add `visibility` attr — detect `private`/`protected` prefixes
- Verify trait->method and object->method emit CONTAINS edges
- Keep existing DEFINES, IMPORTS edges

### TypeScriptParser

- Use `Interface` for interface matches (was `Class`)
- Use `Method` for methods inside classes (was `Function`)
- Add CONTAINS edges — file->class, class->method (currently only DEFINES)
- Add `signature` attr — capture matched line
- Add `visibility` attr — detect public/private/protected
- Keep existing DEFINES, IMPORTS, CALLS edges
- Keep file-level content on File node

### Symbol Attributes

| Attribute | Source | Required |
|-----------|--------|----------|
| name | Already emitted | Yes |
| language | Already emitted | Yes |
| lineStart | Already emitted | Yes |
| lineEnd | Already emitted | Yes |
| signature | First line of match, trimmed | Optional |
| visibility | Regex prefix check | Optional |
| summary | Already emitted for some | Keep if exists |

---

## 3. Query Ranking — Symbol Preference

### RelevanceScorer Changes

Add a `kindBoost` factor to the existing relevance formula:

```
relevance = min(1.0, hopRelevance * exactBoost * pathBoost * kindBoost)
```

| NodeKind | Boost | Rationale |
|----------|-------|-----------|
| Method, Function | 1.3x | Most useful for "what does X do" queries |
| Class, Trait, Object, Interface | 1.3x | Symbol-level structural answers |
| Module | 1.2x | Useful but less specific |
| File | 0.6x | Content blob — deprioritize when symbols exist |
| Config, ConfigEntry | 1.0x | Neutral |
| Doc | 1.0x | Neutral |
| Intent, Decision, Service, Endpoint, Variable | 1.0x | Neutral |

### Implementation

Pass `Map[NodeId, NodeKind]` from already-fetched nodes in `ContextService` into `RelevanceScorer.scoreWithTerms()`. No extra DB queries needed.

---

## 4. Search Improvements

### Sort symbols first

Add ordering to the search AQL — symbol NodeKinds sort above file/config/doc nodes:

```aql
SORT n.kind IN ["function","method","class","trait","object","interface"] ? 0 : 1,
     n.name ASC
```

### Add attribute search

Search node attrs (especially signature) in addition to name/provenance/claims:

```aql
LET attr_matches = (
  FOR n IN nodes
    FILTER n.deleted_rev == null
      AND CONTAINS(LOWER(TO_STRING(n.attrs)), LOWER(@text))
    RETURN DISTINCT n.logical_id
)
```

No fulltext index needed at current scale.

---

## 5. Preserved Behavior

The following must not regress:

- File-level content on TypeScript and Scala file nodes
- compactClaims token efficiency
- Config/Markdown/Python parsing (untouched)
- Decisions and intents (ix_decide, ix_truth, neutral kindBoost)
- Global diff without entityId
- Cross-file import edge resolution
- Existing DEFINES, CONTAINS, IMPORTS, CALLS edges

---

## 6. Files Modified

| File | Change |
|------|--------|
| `Node.scala` | Add Object, Trait, Interface, Method to NodeKind |
| `ScalaParser.scala` | Use correct kinds, add signature/visibility attrs |
| `TypeScriptParser.scala` | Use Interface/Method, add CONTAINS edges, add attrs |
| `RelevanceScorer.scala` | Add kindBoost factor |
| `ContextService.scala` | Pass node-kind map to scorer |
| `ArangoGraphQueryApi.scala` | Add attr search + sort to search query |

---

## 7. Not In Scope

- Tree-sitter integration
- New MCP tools or routes
- Schema migrations or new ArangoDB collections
- Fulltext indexing
- Type resolution or inheritance graphs
- Parser rewrites
- Languages beyond TypeScript and Scala

---

## 8. Expected Outcome

A query like "what parses claims?" returns:

```
parseClaim
  kind: Method
  file: ArangoGraphQueryApi.scala
  line: 48-96
  signature: def parseClaim(doc: VPackSlice): Claim
  summary: deserializes Arango JSON into Claim model
```

Instead of a file content blob.

---

## 9. Validation Checklist

### TypeScript
- [ ] `.ts` file still has file-level content
- [ ] Symbol nodes emitted (Class, Interface, Function, Method)
- [ ] CONTAINS edges (file->class, class->method)
- [ ] IMPORTS edges preserved
- [ ] CALLS edges preserved

### Scala
- [ ] `.scala` file produces symbol nodes (Trait, Object, Class, Method, Function)
- [ ] CONTAINS edges (class->method, trait->method, object->method)
- [ ] IMPORTS edges preserved
- [ ] DEFINES edges preserved
- [ ] signature and visibility attrs present

### Query
- [ ] "what parses claims" returns symbol-level result, not file blob
- [ ] compact query remains small (8 claims, 8 nodes, 10 edges)
- [ ] File content still accessible in full/standard depth

### Search
- [ ] `ix_search("parseClaim")` finds the symbol
- [ ] `ix_search("ContextService")` finds the symbol
- [ ] `ix_search("GraphPatchBuilder")` finds the symbol
- [ ] Symbol nodes sort above file nodes in results
