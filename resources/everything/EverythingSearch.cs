using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;

// Read-only SDK client, isolated from Electron and bounded by the parent process.
class EverythingSearch {
    [DllImport("Everything64.dll", CharSet=CharSet.Unicode)] static extern void Everything_SetSearchW(string text);
    [DllImport("Everything64.dll")] static extern void Everything_SetMax(uint count);
    [DllImport("Everything64.dll")] static extern void Everything_SetRequestFlags(uint flags);
    [DllImport("Everything64.dll")] static extern void Everything_SetSort(uint sort);
    [DllImport("Everything64.dll")] static extern bool Everything_QueryW(bool wait);
    [DllImport("Everything64.dll")] static extern uint Everything_GetLastError();
    [DllImport("Everything64.dll")] static extern uint Everything_GetNumResults();
    [DllImport("Everything64.dll")] static extern uint Everything_GetTotResults();
    [DllImport("Everything64.dll")] static extern bool Everything_IsFolderResult(uint index);
    [DllImport("Everything64.dll", CharSet=CharSet.Unicode)] static extern uint Everything_GetResultFullPathNameW(uint index, StringBuilder buffer, uint size);
    [DllImport("Everything64.dll")] static extern bool Everything_GetResultSize(uint index, out long size);
    [DllImport("Everything64.dll")] static extern void Everything_CleanUp();
    static int Main() {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        var json = new JavaScriptSerializer();
        try {
            var input = json.Deserialize<Dictionary<string, object>>(Console.In.ReadToEnd());
            string query = Convert.ToString(input["query"]);
            int limit = Math.Min(200, Math.Max(1, Convert.ToInt32(input["limit"])));
            if (query.Length == 0 || query.Length > 2048) throw new Exception("Invalid search");
            Everything_SetSearchW(query);
            Everything_SetMax((uint)limit);
            Everything_SetSort(1);
            Everything_SetRequestFlags(7 | 0x10);
            if (!Everything_QueryW(true)) throw new Exception("Everything SDK error " + Everything_GetLastError());
            var items = new List<object>();
            uint count = Everything_GetNumResults();
            for (uint i = 0; i < count; i++) {
                var buffer = new StringBuilder(32768);
                Everything_GetResultFullPathNameW(i, buffer, 32768);
                long size; bool sized = Everything_GetResultSize(i, out size);
                items.Add(new { path=buffer.ToString(), kind=Everything_IsFolderResult(i) ? "folder" : "file", size=sized && size >= 0 ? (object)size : null });
            }
            Console.Write(json.Serialize(new { items=items, total=Everything_GetTotResults() }));
            return 0;
        } catch (Exception error) {
            Console.Write(json.Serialize(new { error=error.Message })); return 1;
        } finally { try { Everything_CleanUp(); } catch {} }
    }
}
