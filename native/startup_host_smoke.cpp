#include <windows.h>

#include <iostream>

int wmain(int argc, wchar_t** argv) {
  if (argc != 2) {
    std::wcerr << L"usage: startup_host_smoke <cfb27_lua_host.dll>\n";
    return 2;
  }
  HMODULE host = LoadLibraryW(argv[1]);
  if (!host) {
    std::wcerr << L"LoadLibrary failed: " << GetLastError() << L'\n';
    return 1;
  }
  Sleep(10000);
  return 0;
}
