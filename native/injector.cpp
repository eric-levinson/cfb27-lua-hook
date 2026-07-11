#include <windows.h>
#include <tlhelp32.h>

#include <filesystem>
#include <iostream>
#include <string>

namespace {

bool EndsWithInsensitive(std::wstring value, std::wstring suffix) {
  if (value.size() < suffix.size()) return false;
  value = value.substr(value.size() - suffix.size());
  return _wcsicmp(value.c_str(), suffix.c_str()) == 0;
}
bool RealAnticheatIsRunning() {
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return true;
  PROCESSENTRY32W entry{sizeof(entry)};
  bool found = false;
  if (Process32FirstW(snapshot, &entry)) {
    do {
      std::wstring name(entry.szExeFile);
      if (name.find(L"Javelin") == std::wstring::npos && name.find(L"EAAntiCheat") == std::wstring::npos &&
          name.find(L"EAAnticheat") == std::wstring::npos) continue;
      HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, entry.th32ProcessID);
      if (!process) {
        found = true;
        break;
      }
      wchar_t path[MAX_PATH]{};
      DWORD size = MAX_PATH;
      if (QueryFullProcessImageNameW(process, 0, path, &size)) {
        WIN32_FILE_ATTRIBUTE_DATA data{};
        if (GetFileAttributesExW(path, GetFileExInfoStandard, &data)) {
          const ULONGLONG bytes = (static_cast<ULONGLONG>(data.nFileSizeHigh) << 32) | data.nFileSizeLow;
          if (bytes >= 1024 * 1024) found = true;
        } else {
          found = true;
        }
      } else {
        found = true;
      }
      CloseHandle(process);
      if (found) break;
    } while (Process32NextW(snapshot, &entry));
  }
  CloseHandle(snapshot);
  return found;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  if (argc != 3) {
    std::wcerr << L"usage: cfb27_hook_injector.exe <pid> <absolute-dll-path>\n";
    return 2;
  }
  const DWORD pid = std::wcstoul(argv[1], nullptr, 10);
  const std::filesystem::path dll_path = std::filesystem::absolute(argv[2]);
  if (!std::filesystem::is_regular_file(dll_path)) {
    std::wcerr << L"hook DLL was not found: " << dll_path << L"\n";
    return 3;
  }
  if (RealAnticheatIsRunning()) {
    std::wcerr << L"refusing to inject while a real EA anticheat/Javelin process is running\n";
    return 4;
  }

  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_CREATE_THREAD |
                                   PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_VM_READ,
                               FALSE, pid);
  if (!process) {
    std::wcerr << L"OpenProcess failed: " << GetLastError() << L"\n";
    return 5;
  }
  wchar_t process_path[MAX_PATH]{};
  DWORD process_path_size = MAX_PATH;
  if (!QueryFullProcessImageNameW(process, 0, process_path, &process_path_size) ||
      !EndsWithInsensitive(process_path, L"CollegeFB27.exe")) {
    std::wcerr << L"target is not CollegeFB27.exe\n";
    CloseHandle(process);
    return 6;
  }

  const std::wstring path_text = dll_path.wstring();
  const SIZE_T path_bytes = (path_text.size() + 1) * sizeof(wchar_t);
  void* remote_path = VirtualAllocEx(process, nullptr, path_bytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
  if (!remote_path || !WriteProcessMemory(process, remote_path, path_text.c_str(), path_bytes, nullptr)) {
    std::wcerr << L"could not copy DLL path into the game process: " << GetLastError() << L"\n";
    if (remote_path) VirtualFreeEx(process, remote_path, 0, MEM_RELEASE);
    CloseHandle(process);
    return 7;
  }

  auto load_library = reinterpret_cast<LPTHREAD_START_ROUTINE>(
      GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "LoadLibraryW"));
  HANDLE thread = CreateRemoteThread(process, nullptr, 0, load_library, remote_path, 0, nullptr);
  if (!thread) {
    std::wcerr << L"CreateRemoteThread failed: " << GetLastError() << L"\n";
    VirtualFreeEx(process, remote_path, 0, MEM_RELEASE);
    CloseHandle(process);
    return 8;
  }
  WaitForSingleObject(thread, 15'000);
  DWORD module_handle = 0;
  GetExitCodeThread(thread, &module_handle);
  CloseHandle(thread);
  VirtualFreeEx(process, remote_path, 0, MEM_RELEASE);
  CloseHandle(process);
  if (!module_handle) {
    std::wcerr << L"LoadLibraryW failed inside the game process\n";
    return 9;
  }
  std::wcout << L"CFB27 live hook loaded into PID " << pid << L"\n";
  return 0;
}
