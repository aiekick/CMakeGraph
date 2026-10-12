# Changelog

## 0.1.3 — 2026-10-12

### Packaging

- The vsix manifest now carries what the Marketplace expects (engine,
  extension kind, links, icon, license and changelog), like the one
  vsce generates.
- The changelog lists the newest version first again.

## 0.1.2 — 2026-10-12

### CMake Tools only

- CMakeGraph now requires the CMake Tools extension
  (`ms-vscode.cmake-tools`) and no longer has a standalone mode.
- Build, build of a target or a section, clean and tests go through the
  CMake Tools API, so the selected kit or preset and its environment
  apply. A build without a precise target builds the CMake Tools default
  target.
- The `buildDir`, `cmakePath`, `ctestPath`, `cpackPath` and
  `defaultJobs` settings are gone, along with the *Select build folder*
  command and its title bar buttons. The build folder is always the one
  CMake Tools reports.
- The per target *Rebuild* stays on `cmake --build ... --clean-first`,
  the API having no equivalent: it runs the cmake of the cache
  (`CMAKE_COMMAND`), with `cmake.parallelJobs` for the parallelism.
- The configuration selector of CMakeGraph only drives the display and
  the rebuild; build and tests use the CMake Tools configuration.
- The Problems pane of CMakeGraph only receives the configure run with
  the CMake debugger.

### 2D / 3D graph

- The dependency graph can be rendered in 2D or in 3D (WebGL).

### Configuration pane removed

- The CMake variables pane is gone: the cache is edited with the
  CMakeParams extension.

### Fixes

- Clean passed the build folder in place of the cmake path.

## 0.1.1 — 2026-09-23

- New *Configure with CMake Debugger* button in the Project Outline
  title (CMake >= 3.27).

## 0.1.0 — 2026-03-02

- Big refactoring of the code.

## 0.0.3 — 2026-03-16

- No more cmake query created when the project has no `CMakeLists.txt`.

## 0.0.2 — 2026-03-05

- Fix the switch between the 2D and the 3D graph.

## 0.0.1 — 2026-02-22

Initial release.
