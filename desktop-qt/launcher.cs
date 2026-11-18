using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;
using System.Reflection;
[assembly: AssemblyTitle("Go-Antigravity")]
[assembly: AssemblyProduct("Go-Antigravity")]
[assembly: AssemblyDescription("Native PyQt desktop launcher")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]
internal static class Launcher {
    private static string Quote(string value) {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append(c); slashes = 0; continue; }
            result.Append('\\', slashes); slashes = 0; result.Append(c);
        }
        result.Append('\\', slashes * 2); result.Append('"');
        return result.ToString();
    }
    [STAThread]
    private static void Main(string[] args) {
        try {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string script = Path.Combine(root, "Start-Go-Antigravity.ps1");
            if (!File.Exists(script)) throw new FileNotFoundException("Keep the launcher inside the complete Go-Antigravity folder.");
            string command = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " + Quote(script);
            foreach (string arg in args) command += " " + Quote(arg);
            var start = new ProcessStartInfo(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), @"WindowsPowerShell\v1.0\powershell.exe"), command);
            start.WorkingDirectory = root;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.RedirectStandardOutput = true;
            start.RedirectStandardError = true;
            var errors = new StringBuilder();
            using (var process = new Process()) {
                process.StartInfo = start;
                process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e) { };
                process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e) {
                    if (e.Data != null) lock(errors) { if (errors.Length < 4000) errors.AppendLine(e.Data); }
                };
                process.Start();
                process.BeginOutputReadLine();
                process.BeginErrorReadLine();
                process.WaitForExit();
                if (process.ExitCode != 0) throw new InvalidOperationException("Startup failed. Run Start-Go-Antigravity.cmd for details.\n" + errors.ToString());
            }
        } catch (Exception error) {
            MessageBox.Show(error.Message, "Go-Antigravity", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
