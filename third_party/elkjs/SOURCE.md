# elkjs source and selected license

The canvas lockfile pins `elkjs@0.12.1` from npm with integrity:
`sha512-IhMYKHE4S2vtx0QrhBP3lYOIKDeIiJXBrdq9MGYkuB8ZHqhrBnHNfSUndjXFewrX1CPK8chwq+2NA0K0hliYuw==`.

The package declares `EPL-2.0 OR GPL-3.0-or-later`. This AGPL distribution uses
the GPL-3.0-or-later option (GPL v3 for the combination) and retains all original
EPL/GPL notices. The license text is in `../licenses/elkjs-LICENSE.md`.

The original sources and build scripts are supplied in `sources/`:

- `elkjs-0.12.1-source.zip`: official repository snapshot at npm's gitHead,
  `624ae90aa37110033a8af59c5ccbb292708b4317`.
- `elk-core-0.12.0-source.zip`: the matching ELK minor-release source line,
  tag `v0.12.0`, commit `323312916048544e4e594eab3303cdb0d01e2929`.

These archives retain upstream file names, licenses, source and build files.
No source inside them is modified by AIDesignHub. The application uses the
published npm JS artifacts without patching them. The upstream README explains
the relationship between elkjs revision numbers and the corresponding ELK minor
release, and its build requires sibling `elkjs` and `elk` checkouts, Java,
Gradle, Babel and Browserify. Dependencies and tasks remain in the supplied
build.gradle/package.json rather than being replaced by a minified bundle.

Sources:
https://github.com/kieler/elkjs/tree/624ae90aa37110033a8af59c5ccbb292708b4317
https://github.com/eclipse-elk/elk/tree/323312916048544e4e594eab3303cdb0d01e2929

Archive hashes and source provenance are recorded in UPSTREAM.json.
