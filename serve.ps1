$root = "C:\Users\asus\.zcode\workspace\default\blue-bunny-swing"
$mime = @{ ".html"="text/html"; ".css"="text/css"; ".js"="application/javascript" }
$http = [System.Net.HttpListener]::new()
$http.Prefixes.Add("http://127.0.0.1:8643/")
$http.Start()
Write-Host "serving on 8643"
while ($http.IsListening) {
  $ctx = $http.GetContext()
  $path = $ctx.Request.Url.AbsolutePath.TrimStart("/")
  if ($path -eq "") { $path = "index.html" }
  $file = Join-Path $root $path
  if (Test-Path $file -PathType Leaf) {
    $bytes = [IO.File]::ReadAllBytes($file)
    $ext = [IO.Path]::GetExtension($file).ToLower()
    $ctx.Response.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { "application/octet-stream" }
    $ctx.Response.Headers.Add("Cache-Control", "no-cache, no-store")
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  } else {
    $ctx.Response.StatusCode = 404
  }
  $ctx.Response.Close()
}
