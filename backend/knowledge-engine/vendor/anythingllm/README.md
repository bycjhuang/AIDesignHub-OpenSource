# AnythingLLM knowledge core

This directory vendors the MIT-licensed AnythingLLM core from **v1.18.0**, commit `3e4f9411b67f2dd7fa9fc6f2b95dfacbda0633ba`. `UPSTREAM.json` records original and adapted SHA-256 values. `LICENSE` is the unchanged upstream license.

`upstream/` retains the exact original LanceDb provider, VectorDatabase base, and TextSplitter modules. `runtime/` contains the modules executed by BYCJ Design Desktop. The LanceDb adaptation replaces server imports with constructor dependency injection and makes storage/connection instance-scoped. The ingestion, splitting, cosine similarity, namespace, and document-deletion algorithms remain the upstream implementation. Base and TextSplitter are byte-identical to their original modules.

The host adapter is `runtime/knowledge/anythingllm.ts`. Existing local parsing and multilingual E5 embeddings remain host services. Document metadata and vector ID mappings are reconstructed from the durable version 2 JSON store; LanceDB tables are derived caches, organized by project, model, dimensions, and content hash. New imports execute the upstream `addDocumentToNamespace`, and searches and removals execute its `similarityResponse` and deletion methods. No global environment or cross-instance database singleton is used.

This is a core integration. It does not ship AnythingLLM's separate Express/Prisma application, collector, account system, agent, or official user interface. Native failure is reported as degraded local full-text retrieval. Optional upstream reranking is disabled.

All personal documents, JSON stores, vector tables, and migration snapshots are created only in the runtime data directory supplied by the desktop host. This vendor directory contains public source and license files only.
