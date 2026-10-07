using System.Diagnostics;
using System.Xml.Linq;

namespace EdizRemote.Desktop.Tests;

public sealed class PackagingTests
{
    [Fact]
    public void WebContentIsExternalToTheSingleFileAndOwnedByPublishScript()
    {
        var repositoryRoot = FindRepositoryRoot();
        var projectPath = Path.Combine(
            repositoryRoot,
            "apps",
            "windows-desktop",
            "EdizRemote.Desktop.csproj");
        var project = XDocument.Load(projectPath);
        var webContent = Assert.Single(
            project.Descendants("Content"),
            element =>
                ((string?)element.Attribute("Include"))?.Contains(
                    @"..\web\dist\",
                    StringComparison.OrdinalIgnoreCase) == true);

        Assert.Equal(
            "Never",
            webContent.Element("CopyToPublishDirectory")?.Value);
        Assert.Equal(
            "true",
            webContent.Element("ExcludeFromSingleFile")?.Value);
    }

    [Fact]
    public async Task PublishValidatorAcceptsCompleteLocalIndexReferences()
    {
        var webRoot = CreateWebPackage(includeJavaScript: true);
        try
        {
            var result = await RunValidatorAsync(webRoot);

            Assert.Equal(0, result.ExitCode);
            Assert.Contains("WEB_PACKAGE_OK", result.Output);
        }
        finally
        {
            Directory.Delete(webRoot, recursive: true);
        }
    }

    [Fact]
    public async Task PublishValidatorFailsWhenIndexReferencesMissingAsset()
    {
        var webRoot = CreateWebPackage(includeJavaScript: false);
        try
        {
            var result = await RunValidatorAsync(webRoot);

            Assert.NotEqual(0, result.ExitCode);
            Assert.Contains("WEB_PACKAGE_MISSING_REFERENCE", result.Output);
        }
        finally
        {
            Directory.Delete(webRoot, recursive: true);
        }
    }

    private static string CreateWebPackage(bool includeJavaScript)
    {
        var webRoot = Path.Combine(
            Path.GetTempPath(),
            $"EdizRemote.PackagingTests.{Guid.NewGuid():N}");
        var assets = Path.Combine(webRoot, "assets");
        Directory.CreateDirectory(assets);
        File.WriteAllText(
            Path.Combine(webRoot, "index.html"),
            """
            <!doctype html>
            <script type="module" src="/assets/app.js"></script>
            <link rel="stylesheet" href="/assets/app.css">
            """);
        File.WriteAllText(Path.Combine(assets, "app.css"), "body {}\n");
        if (includeJavaScript)
        {
            File.WriteAllText(Path.Combine(assets, "app.js"), "export {};\n");
        }
        return webRoot;
    }

    private static async Task<(int ExitCode, string Output)> RunValidatorAsync(
        string webRoot)
    {
        var repositoryRoot = FindRepositoryRoot();
        var scriptPath = Path.Combine(
            repositoryRoot,
            "scripts",
            "windows-desktop.ps1");
        var startInfo = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        startInfo.ArgumentList.Add("-NoProfile");
        startInfo.ArgumentList.Add("-ExecutionPolicy");
        startInfo.ArgumentList.Add("Bypass");
        startInfo.ArgumentList.Add("-File");
        startInfo.ArgumentList.Add(scriptPath);
        startInfo.ArgumentList.Add("validate-web");
        startInfo.ArgumentList.Add("-WebRoot");
        startInfo.ArgumentList.Add(webRoot);

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("PowerShell başlatılamadı.");
        var standardOutput = process.StandardOutput.ReadToEndAsync();
        var standardError = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        return (
            process.ExitCode,
            (await standardOutput) + (await standardError));
    }

    private static string FindRepositoryRoot()
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            if (File.Exists(Path.Combine(directory.FullName, "package.json")) &&
                File.Exists(Path.Combine(
                    directory.FullName,
                    "scripts",
                    "windows-desktop.ps1")))
            {
                return directory.FullName;
            }
            directory = directory.Parent;
        }

        throw new DirectoryNotFoundException("Repository root bulunamadı.");
    }
}
