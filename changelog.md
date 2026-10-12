[0.0.1] : First version
[0.0.2] : Fix issues regarding switch between 2d and 3d graph
[0.0.3] : Fix issue regarding the creation of the cmake query even if the project have no CMakeLists.txt
[0.1.0] : Big refactoring of the code
[0.1.1] : Add a "Configure with CMake Debugger" button in the Project Outline title (CMake >= 3.27)
[0.1.2] : Rely on CMake Tools only: build, clean and tests go through its API; the buildDir, cmakePath, ctestPath, cpackPath and defaultJobs settings and the "Select build folder" command are removed; the per target rebuild runs the cmake of the cache (CMAKE_COMMAND)
