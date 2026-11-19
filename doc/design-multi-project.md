# Design: multi-project view and viewer mode

Status: **draft, not started**. Waiting for information from the requester before any code.
Origin: [issue #4](https://github.com/aiekick/CMakeGraph/issues/4) (endrjux): several top-level CMake projects in one repository, built separately, in different build dirs, with different toolchains, sharing part of their sources.

## 1. Need

- See all the projects at once, without switching the build dir by hand.
- "Impacted targets" must answer across projects: a shared source file impacts targets in several projects.
- The requester does not use CMake Tools. They generate the File API replies themselves, from their own build tasks.

## 2. Decisions taken

| Decision | Detail |
| --- | --- |
| Viewer mode | When CMake Tools is not active, CMakeGraph runs as a **read-only viewer**: it reads existing replies, and offers no build, rebuild, clean, test or configure action. |
| Actions stay CMake Tools only | No setting for the cmake path or preset, no preset parsing. The reasons behind 0.1.2 still hold. |
| Reply dirs setting | A setting lists where to look for replies, with explicit paths or wildcards. |
| Multi-toolchain is a first-class case | One source tree configured with several toolchains gives several builds. This is the same case as several projects. |
| Niche setups matter | This kind of setup exists elsewhere (host + target, multi-MCU firmware). Its users tend to give useful feedback. |

## 3. Vocabulary

Three levels that the current code merges into one (the single `last_reply`):

- **Build**: one reply, so one build dir. Built from one source tree, one toolchain, one generator, possibly several configurations. Label: `project()` name + build dir name + compiler id (from the `toolchains-v1` reply).
- **Module**: a target *declaration*, which may be shared by several builds. This is the shared unit.
- **Instance**: a module as compiled in one build and one configuration. Defines, includes, flags, sources, dependencies and artifacts belong to the instance, never to the module.

## 4. Module identity (the core question)

What says that two targets in two builds are "the same module"?

- **The File API `id` cannot be used.** It looks like `name::@<hash>`, and the hash comes from the directory inside the build tree. It is not portable across builds.
- **The name alone is not enough.** CMake guarantees name uniqueness *inside one project* only. Two projects can each have an unrelated `utils`.
- **The path alone is not enough.** One `CMakeLists.txt` can declare several targets.

**Proposed key: `(target name, absolute real path of the declaring directory)`**. The declaring directory is `target.paths.source` resolved against `codemodel.paths.source`, then passed through `realpath`.

Weak cases of this key, and how each one is handled:

| Case | Result with the key | Handling |
| --- | --- | --- |
| Same directory, same name, different options per build (sources, defines) | Same module, divergent instances | Desired: show the differences (§6) |
| Same directory, name computed per project (`${PROJECT_NAME}_core`) | Two modules | Possible fallback: same declaration site (backtrace of the `add_library`, resolved file and line). To be decided after the requester answers. |
| Declaration inside a helper function (`my_add_lib(name)`) | The top backtrace frame is shared by every target | Do not use the declaration site alone as the key, only as a fallback |
| Library copied or vendored at two locations | Two modules | Correct by default (they are two copies). A "same source set" hint is possible later. |
| Symlinks, case and drive letter (Windows) | Wrongly split | Normalize with `realpath` and case folding on Windows |
| Same directory added twice in one project (two binary dirs) | CMake forces distinct names | No problem |
| Common sources listed directly in each project's targets (no shared target) | No common module | Only files are shared: "Impacted targets" is then the only bridge (§7) |

The last case is crucial: depending on how the requester shares their code, there may be **no common module at all**, only common files. This is the first question to ask them (§10).

## 5. Graph: multiple roots, no fusion problem

The concern "the roots are not the same" goes away: a DAG does not need a single root. If nodes are modules (§4), the union of the builds' graphs is one DAG with several roots (each project's executables) and a shared trunk.

- Node = module. Badge = number of builds that contain it.
- Edge = union of the edges of each build, labelled with the builds where it exists. An edge that is not present in every build is drawn differently.
- Direct links (`direct_links_converter`) are computed **per build, before the union**. The backtraces are only valid inside their own reply.
- Edges could create a cycle in theory (A→B in one build, B→A in another). The force-directed renderer does not mind, but a topological view would. Detect and flag it.

## 6. Outline: flags of a common module

Two possible trees:

- **Build-first** (current behavior, repeated per build): Build › Target › details. Simple and faithful, but common modules are duplicated.
- **Module-first**: Module › details, with each property factorized:
  - identical in every instance: shown once;
  - different: shown per instance (build/config), with a "divergent" badge.
  - Properties compared: sources, defines, includes, compile flags, language standard, dependencies, artifacts.

Proposal: build-first by default (it is where flags really belong), plus a "Common modules" root in module-first form. That root is where the multi-project view adds value.

## 7. Impacted targets

The bridge between builds is the **source file**, by absolute real path:
`file → [(build, module, instance)…]`.

- Exclude generated sources (inside a build dir). They are never shared.
- This works even if no module is shared (last case of §4).

## 8. Filtering

Filtering a project by **hiding** the others removes the interest of the multi-project view. So a filter **highlights** (focus), it does not hide:

- focus on one build: its modules and edges are shown normally, the rest is dimmed;
- a "shared only" focus shows the modules present in at least two builds;
- hiding is still possible, for graphs too large to stay readable.

## 9. Architecture (outline)

```
ReplySource ──┬─ CMakeToolsSource   (current, with actions)
              └─ ReplyDirsSource    (setting, read only)
        ↓
BuildStore     Map<buildKey, Build>   (one ReplyWatcher per build dir)
        ↓
ModuleIndex    modules, instances, merged edges, file → instances
        ↓
providers      outline / graph / impacted
```

- An action (build, rebuild, test…) is available only on a build that comes from `CMakeToolsSource`.
- The configuration selector (Debug/Release) becomes per build, because each build has its own list.

### Setting

`cmakeGraph.replyDirs: string[]`: build dirs, explicit or glob, relative to the workspace folder (`${workspaceFolder}` accepted). A match is valid if `<dir>/.cmake/api/v1/reply/index-*.json` exists.

## 10. Open questions

### For the requester (before starting)

1. Tree of the workspace: where the top-level `CMakeLists.txt` files are, where the build dirs are, where the shared code is.
2. Is the shared code **the same physical files** for every project, or copies or submodules at several locations?
3. Is the shared code built as **a shared target** (same `add_subdirectory`, same target name), or are its sources listed directly in each project's targets? This decides whether §4 to §6 apply, or only §7.
4. Which view matters most to them: impacted targets, outline or graph?
5. CMake version, generator (single or multi-config), and do their tasks already write the `codemodel-v2` / `cache-v2` / `cmakeFiles-v1` / `toolchains-v1` queries?
6. Is the project open source (for a real test case)?

### For us

1. When CMake Tools is active, should `replyDirs` add builds next to the CMake Tools ones, or be ignored? Related: show every CMake Tools project at once (multi-project CMake Tools), not only the active one.
2. In viewer mode, should CMakeGraph write the query files into the matched dirs? That costs nothing and runs no cmake, but it writes into the user's build dir.
3. Fallback identity by declaration site (§4): yes or no.
4. Module-first view: a separate root, or a global toggle of the outline.
