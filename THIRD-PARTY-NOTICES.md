# Third-party components

AIDesignHub combines its project workbench with the following components. Their
respective copyright notices and licenses continue to apply; integration does
not transfer authorship of these components to AIDesignHub.

Original AIDesignHub integration code is AGPL-3.0-only (see LICENSE and
COPYRIGHT.md). This does not replace upstream MIT, Apache, OFL, MPL, LGPL or
other grants. Upstream names are acknowledgments, not endorsements.

| Component | Use | License / notices |
| --- | --- | --- |
| Loomic | Adapted Home, canvas, Agent sidebar and local-mode integration; imported commit `21206c30054572291b9df000d84568aeca97aeda` | [Original MIT license](Loomic-main/Loomic-main/LICENSE), Copyright (c) 2026 Xinmin Zeng; [adaptations](Loomic-main/Loomic-main/ADAPTATIONS.md) |
| Excalidraw 0.18.0 | Canvas editor used by Loomic | [MIT](third_party/excalidraw/LICENSE), Copyright (c) 2020 Excalidraw; fonts have independent licenses |
| DeepSeek Harness 0.2.1-rc.2 | Embedded ADH Agent runtime; tag `dsh-v0.2.1-rc.2`, commit `687f282e8625c6b8d11ff58211a90524be2e4317` | [MIT](third_party/deepseek-harness/LICENSE), Copyright (c) 2026 DeepSeek; original runtime package notices also remain installed |
| Loomic canvas-design / json-image-prompt skills | Upstream skill text; canvas-design identifies Anthropic as author | Apache-2.0; full license beside each SKILL.md; original author metadata retained |
| Loomic canvas-design fonts | 54 TTF files supplied with the upstream skill | OFL-1.1; original embedded authors, [font notices](Loomic-main/Loomic-main/skills/canvas-design/canvas-fonts/FONT-NOTICES.md), license and per-file hashes retained |
| Excalidraw fonts | Canvas fonts, including Assistant, Cascadia, Comic Shanns, Excalifont, Lilita, Nunito, Virgil and Xiaolai | Individual OFL / MIT / Microsoft font notices; [family licenses](third_party/excalidraw/FONT-LICENSES.md) and [original metadata](third_party/excalidraw/FONT-NOTICES.md) |
| Liberation Sans 2.1.5 | Replacement for the old, incompletely documented font in Excalidraw 0.18.0; used in webpack imports and public assets | [OFL-1.1 and original copyright](third_party/fonts/liberation-sans/LICENSE); original TTF, lossless WOFF2 and source/hash/conversion record retained |
| elkjs 0.12.1 | Diagram layout dependency reached through the canvas; pinned override replaces EPL-only 0.9.3 | Upstream `EPL-2.0 OR GPL-3.0-or-later`; GPL-3.0-or-later option used for this AGPL distribution; [unchanged upstream license](third_party/licenses/elkjs-LICENSE.md), source https://github.com/kieler/elkjs/tree/624ae90aa37110033a8af59c5ccbb292708b4317 |
| DeepSeek LibreOffice Kit 0.1.5 and sharp/libvips | Separate native/runtime dependencies of Harness | Respective MPL-2.0 / Apache-2.0 / LGPL notices, engine licenses and source records remain within runtime packages; not covered solely by Harness's MIT license |
| AnythingLLM knowledge components | Local document processing and retrieval | [Upstream license](backend/knowledge-engine/vendor/anythingllm/LICENSE) and [source provenance](backend/knowledge-engine/UPSTREAM.json) |
| LanceDB, Transformers.js, E5, Tesseract and OCR language data | Local search, embeddings and OCR | Runtime packages, bundled asset manifests and corresponding notices are retained in `resources/knowledge/` |
| Electron, Node.js and application dependencies | Desktop shell and local services | Dependency and runtime license files are retained with their packages |

The installer contains runtime code and public model/OCR resources. It does not
include the maintainer's project database, documents, knowledge index, API keys,
Agent account configuration or private skills. Professional applications and
their commercial licenses are supplied by the user.

Pinned upstream license evidence and original license blob IDs are in
[third_party/UPSTREAMS.json](third_party/UPSTREAMS.json). A GitHub source archive
for each AIDesignHub binary release must match its release tag and build baseline.
Source URLs and lockfiles are part of source delivery; a minified canvas export
alone is not the corresponding source.

The primary-project license audit and its limits are documented in
docs/open-source-audit-2026-10-29.md. A primary MIT finding is not an assertion
that every nested package, font, model weight or professional bridge is MIT.
