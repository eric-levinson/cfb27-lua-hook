#include <windows.h>

#include <filesystem>

namespace {

DWORD WINAPI LoadLuaHost(void* module_value) {
  const auto module = static_cast<HMODULE>(module_value);
  wchar_t path[MAX_PATH]{};
  if (!GetModuleFileNameW(module, path, MAX_PATH)) return 1;
  const auto host = std::filesystem::path(path).parent_path() /
                    L"CFB27LiveEditor" / L"cfb27_lua_host.dll";
  return LoadLibraryW(host.c_str()) ? 0 : GetLastError();
}

}  // namespace

BOOL APIENTRY DllMain(HMODULE module, DWORD reason, LPVOID) {
  if (reason == DLL_PROCESS_ATTACH) {
    DisableThreadLibraryCalls(module);
    if (HANDLE thread = CreateThread(nullptr, 0, LoadLuaHost, module, 0, nullptr)) {
      CloseHandle(thread);
    }
  }
  return TRUE;
}
