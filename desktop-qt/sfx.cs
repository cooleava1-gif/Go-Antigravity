using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.Versioning;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("Go-Antigravity")]
[assembly: AssemblyProduct("Go-Antigravity")]
[assembly: AssemblyDescription("Go-Antigravity single-file portable package")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]
// Declaring a modern target framework makes the CLR use .NET Framework 4.6.2+ path handling,
// which is what lets the \\?\ prefix carry the deep Qt payload past MAX_PATH.
[assembly: TargetFramework(".NETFramework,Version=v4.8", FrameworkDisplayName = ".NET Framework 4.8")]

// Single-file portable release package: the verified release ZIP is appended to this stub by
// scripts/build-portable-exe.ps1. Running the EXE unpacks that payload next to itself and starts
// the packaged launcher, so a release is one download instead of a ZIP plus a folder.
internal static class PortablePackage
{
    private const string PackageFolder = "Go-Antigravity-windows-x64";
    private const string LauncherName = "Go-Antigravity.exe";
    private const string ManifestRelative = "runtime/manifest.json";

    [STAThread]
    private static int Main(string[] args)
    {
        bool extractOnly = false;
        bool force = false;
        bool quiet = false;
        string requestedTarget = null;
        var passthrough = new List<string>();
        for (int index = 0; index < args.Length; index++)
        {
            string argument = args[index];
            if (IsFlag(argument, "--extract-only")) { extractOnly = true; continue; }
            if (IsFlag(argument, "--force")) { force = true; continue; }
            if (IsFlag(argument, "--quiet")) { quiet = true; continue; }
            if (IsFlag(argument, "--target") && index + 1 < args.Length) { requestedTarget = args[++index]; continue; }
            passthrough.Add(argument);
        }
        try
        {
            string self = Application.ExecutablePath;
            long payload = LocatePayload(self);
            string root = requestedTarget == null
                ? Path.Combine(Path.GetDirectoryName(self), PackageFolder)
                : Path.GetFullPath(requestedTarget);
            string packaged = NormalizeVersion(FileVersionInfo.GetVersionInfo(self).FileVersion);
            string installed = NormalizeVersion(ReadManifestVersion(Path.Combine(root, ManifestRelative)));
            bool current = installed.Length > 0 && packaged.Length > 0
                && (installed == packaged || installed.StartsWith(packaged + "-", StringComparison.OrdinalIgnoreCase));
            if (force || !current)
            {
                Extract(self, payload, root, quiet);
            }
            if (extractOnly) return 0;
            Start(Path.Combine(root, LauncherName), root, passthrough);
            return 0;
        }
        catch (Exception error)
        {
            // A failed unpack has to leave evidence even when the EXE runs unattended.
            try { File.WriteAllText(Path.Combine(Path.GetTempPath(), "go-antigravity-unpack.log"), error.ToString()); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            if (!quiet)
            {
                MessageBox.Show(error.Message, "Go-Antigravity", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
            return 1;
        }
    }

    private static bool IsFlag(string value, string flag)
    {
        return string.Equals(value, flag, StringComparison.OrdinalIgnoreCase);
    }

    // The payload is the release ZIP appended to this executable, so the ZIP's central directory
    // sits at the end of the file and its offset there already accounts for the stub in front.
    private static long LocatePayload(string path)
    {
        using (var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            long length = file.Length;
            int tailLength = (int)Math.Min(length, 1024 * 65);
            if (tailLength < 22) throw new InvalidOperationException("The portable package is incomplete: run it again after a full download.");
            var tail = new byte[tailLength];
            file.Seek(length - tailLength, SeekOrigin.Begin);
            ReadFully(file, tail, tailLength);
            for (int index = tailLength - 22; index >= 0; index--)
            {
                if (tail[index] != 0x50 || tail[index + 1] != 0x4B || tail[index + 2] != 0x05 || tail[index + 3] != 0x06) continue;
                int comment = tail[index + 20] | (tail[index + 21] << 8);
                if (index + 22 + comment != tailLength) continue;
                long directorySize = BitConverter.ToUInt32(tail, index + 12);
                long directoryOffset = BitConverter.ToUInt32(tail, index + 16);
                long start = length - tailLength + index - directorySize - directoryOffset;
                if (start <= 0) continue;
                file.Seek(start, SeekOrigin.Begin);
                var signature = new byte[4];
                ReadFully(file, signature, 4);
                if (signature[0] == 0x50 && signature[1] == 0x4B && signature[2] == 0x03 && signature[3] == 0x04) return start;
            }
        }
        throw new InvalidOperationException("This EXE carries no release payload. Download Go-Antigravity-windows-x64.exe again.");
    }

    private static void ReadFully(Stream stream, byte[] buffer, int count)
    {
        int offset = 0;
        while (offset < count)
        {
            int read = stream.Read(buffer, offset, count - offset);
            if (read <= 0) throw new EndOfStreamException("The portable package is truncated.");
            offset += read;
        }
    }

    private static void CopyPayload(string self, long payload, string destination)
    {
        using (var source = new FileStream(self, FileMode.Open, FileAccess.Read, FileShare.Read))
        using (var target = new FileStream(destination, FileMode.Create, FileAccess.Write, FileShare.None))
        {
            source.Seek(payload, SeekOrigin.Begin);
            var buffer = new byte[1024 * 256];
            int read;
            while ((read = source.Read(buffer, 0, buffer.Length)) > 0)
            {
                target.Write(buffer, 0, read);
            }
        }
    }

    private static void Extract(string self, long payload, string root, bool quiet)
    {
        string parent = Path.GetDirectoryName(root);
        if (string.IsNullOrEmpty(parent)) throw new InvalidOperationException("无法确定发布目录。");
        if (!Directory.Exists(parent)) Directory.CreateDirectory(parent);
        Splash splash = quiet ? null : new Splash("正在准备 Go-Antigravity…");
        Exception failure = null;
        var worker = new Thread(delegate()
        {
            string temp = Path.Combine(Path.GetTempPath(), "go-antigravity-" + Guid.NewGuid().ToString("N"));
            // Stage beside the target so the final rename stays on one volume.
            string staged = Path.Combine(parent, "." + Path.GetFileName(root) + ".incoming-" + Guid.NewGuid().ToString("N").Substring(0, 8));
            try
            {
                Directory.CreateDirectory(temp);
                string archive = Path.Combine(temp, "payload.zip");
                CopyPayload(self, payload, archive);
                ReportTo(splash, "正在解压运行环境…");
                Directory.CreateDirectory(staged);
                ExtractArchive(archive, staged);
                string inner = Path.Combine(staged, PackageFolder);
                if (!Directory.Exists(inner)) throw new InvalidOperationException("内置发布包结构无效，缺少 " + PackageFolder + "。");
                string aside = null;
                if (Directory.Exists(root))
                {
                    aside = root + ".old-" + Guid.NewGuid().ToString("N").Substring(0, 8);
                    Directory.Move(root, aside);
                }
                try
                {
                    Directory.Move(inner, root);
                }
                catch
                {
                    if (aside != null && !Directory.Exists(root))
                    {
                        try { Directory.Move(aside, root); } catch (IOException) { }
                    }
                    throw;
                }
                if (aside != null)
                {
                    try { Directory.Delete(aside, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
                }
            }
            catch (IOException error)
            {
                failure = new IOException(error.Message + " 请把发布包放到更短的路径后重试。", error);
            }
            catch (Exception error)
            {
                failure = error;
            }
            finally
            {
                try { Directory.Delete(staged, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
                try { Directory.Delete(temp, true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
                CloseSplash(splash);
            }
        });
        worker.IsBackground = true;
        worker.Start();
        if (splash != null) Application.Run(splash); else worker.Join();
        if (failure != null) throw new InvalidOperationException("解压发布包失败：" + failure.Message, failure);
    }

    // Windows PowerShell 5.1 writes ZIP entry names with backslashes while pwsh writes forward
    // slashes, so entries are normalised here instead of trusting one producer. Qt ships paths
    // that push the extracted file over MAX_PATH, so every write goes through the \\?\ prefix.
    private static void ExtractArchive(string archive, string destination)
    {
        string root = Path.GetFullPath(destination);
        if (!Directory.Exists(root)) Directory.CreateDirectory(root);
        using (var zip = ZipFile.OpenRead(archive))
        {
            foreach (var entry in zip.Entries)
            {
                string name = (entry.FullName ?? string.Empty).Replace('\\', '/').TrimStart('/');
                if (name.Length == 0) continue;
                string target = root;
                bool directory = name.EndsWith("/", StringComparison.Ordinal);
                foreach (string part in name.TrimEnd('/').Split('/'))
                {
                    if (part.Length == 0 || part == "." || part == "..") throw new InvalidOperationException("发布包包含无效路径：" + name);
                    if (part != part.TrimEnd(' ', '.') || part.IndexOf(':') >= 0) throw new InvalidOperationException("发布包包含无效路径：" + name);
                    target = Path.Combine(target, part);
                }
                if (!target.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("发布包路径越界：" + name);
                if (directory)
                {
                    Directory.CreateDirectory(LongPath(target));
                    continue;
                }
                Directory.CreateDirectory(LongPath(Path.GetDirectoryName(target)));
                using (Stream source = entry.Open())
                using (var sink = new FileStream(LongPath(target), FileMode.Create, FileAccess.Write, FileShare.None))
                {
                    var buffer = new byte[1024 * 256];
                    int read;
                    while ((read = source.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        sink.Write(buffer, 0, read);
                    }
                }
            }
        }
    }

    private static string LongPath(string path)
    {
        if (path.Length < 240) return path;
        if (path.StartsWith(@"\\?\", StringComparison.Ordinal)) return path;
        if (path.StartsWith(@"\\", StringComparison.Ordinal)) return @"\\?\UNC\" + path.Substring(2);
        return @"\\?\" + Path.GetFullPath(path);
    }

    private static void Start(string launcher, string root, List<string> arguments)
    {
        if (!File.Exists(launcher)) throw new InvalidOperationException("The release folder is missing " + LauncherName + ".");
        var info = new ProcessStartInfo(launcher);
        info.WorkingDirectory = root;
        info.UseShellExecute = true;
        info.Arguments = JoinArguments(arguments);
        Process.Start(info);
    }

    private static string JoinArguments(List<string> arguments)
    {
        var builder = new StringBuilder();
        foreach (string argument in arguments)
        {
            if (builder.Length > 0) builder.Append(' ');
            builder.Append(Quote(argument));
        }
        return builder.ToString();
    }

    private static string Quote(string value)
    {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') { result.Append('\\', slashes * 2 + 1); result.Append(character); slashes = 0; continue; }
            result.Append('\\', slashes);
            slashes = 0;
            result.Append(character);
        }
        result.Append('\\', slashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static string ReadManifestVersion(string path)
    {
        try
        {
            if (!File.Exists(path)) return string.Empty;
            string text = File.ReadAllText(path, Encoding.UTF8);
            Match match = Regex.Match(text, "\"version\"\\s*:\\s*\"([^\"]*)\"");
            return match.Success ? match.Groups[1].Value : string.Empty;
        }
        catch (IOException)
        {
            return string.Empty;
        }
    }

    private static string NormalizeVersion(string value)
    {
        if (string.IsNullOrEmpty(value)) return string.Empty;
        string[] parts = value.Trim().TrimStart('v', 'V').Split('.');
        if (parts.Length < 3) return string.Empty;
        return parts[0] + "." + parts[1] + "." + parts[2];
    }

    private static void ReportTo(Splash splash, string text)
    {
        if (splash == null) return;
        try { splash.BeginInvoke((MethodInvoker)delegate { splash.Report(text); }); }
        catch (InvalidOperationException) { }
    }

    private static void CloseSplash(Splash splash)
    {
        if (splash == null) return;
        for (int attempt = 0; attempt < 400; attempt++)
        {
            if (splash.IsDisposed) return;
            try
            {
                splash.BeginInvoke((MethodInvoker)delegate { splash.Close(); });
                return;
            }
            catch (InvalidOperationException) { Thread.Sleep(25); }
        }
    }

    private sealed class Splash : Form
    {
        private readonly Label label;

        public Splash(string text)
        {
            Text = "Go-Antigravity";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            StartPosition = FormStartPosition.CenterScreen;
            ShowInTaskbar = true;
            MaximizeBox = false;
            MinimizeBox = false;
            ControlBox = false;
            TopMost = true;
            ClientSize = new Size(380, 104);
            label = new Label();
            label.TextAlign = ContentAlignment.MiddleCenter;
            label.SetBounds(12, 14, ClientSize.Width - 24, 40);
            label.Text = text;
            var bar = new ProgressBar();
            bar.Style = ProgressBarStyle.Marquee;
            bar.MarqueeAnimationSpeed = 30;
            bar.SetBounds(12, 66, ClientSize.Width - 24, 16);
            Controls.Add(label);
            Controls.Add(bar);
        }

        public void Report(string text)
        {
            label.Text = text;
        }
    }
}
