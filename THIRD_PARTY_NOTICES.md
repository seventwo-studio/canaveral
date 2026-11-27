# Third-party notices

Launch photograph

Photo by Paris Bilal on Unsplash, image ID X3o5blcQGXA.
Files: dashboard/public/launch.jpg and canaveral/web/launch.jpg.
This photograph is covered by the Unsplash License, not this repository's MIT
license. License and terms: https://unsplash.com/license
Commercial and noncommercial use and modification are permitted. Selling the
unmodified image or compiling images to replicate a competing service is excluded.

Bundled font license terms are in dashboard/public/licenses.txt and
canaveral/web/licenses.txt. Dependency packages retain their own licenses.

## Managed model engines

Canaveral fetches these releases from their upstream projects. The packages
retain license and notice files for the installed components.

- Ollama v0.40.17 (MIT). The macOS and Linux archives include licenses and notices
  for bundled libraries and tools. [Ollama license](https://github.com/ollama/ollama/blob/v0.40.17/LICENSE)
- llama.cpp v1.0.0 (MIT). The stable release identifies b12359 as its binary
  build tag. [llama.cpp license](https://github.com/ggml-org/llama.cpp/blob/v1.0.0/LICENSE)

The model executor decodes Zstandard archives with [ruzstd 0.9.1](https://crates.io/crates/ruzstd/0.9.1) (MIT).

## Canaveral host installer

The installer downloads Linux executables from the upstream releases of
[containerd](https://github.com/containerd/containerd/blob/v2.4.2/LICENSE)
and [runc](https://github.com/opencontainers/runc/blob/v1.5.3/LICENSE).
Both projects are licensed under the Apache License, Version 2.0. See the
[containerd notices](https://github.com/containerd/containerd/blob/v2.4.2/NOTICE)
and [runc notices](https://github.com/opencontainers/runc/blob/v1.5.3/NOTICE).
