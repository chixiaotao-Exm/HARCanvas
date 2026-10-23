# Instabox 部署

服务由 systemd 管理，使用独立的 `harcanvas` 系统用户。应用和版本放在
`/data/workspace/har-canvas/releases`，`current` 指向当前版本。
登录配置和可选的默认 HAR 放在 `shared`，不进入 Git。

本地先构建前端和 Linux amd64 可执行文件：

```powershell
cd web
npm ci
npm run build
cd ..
$env:GOOS = 'linux'
$env:GOARCH = 'amd64'
$env:CGO_ENABLED = '0'
go build -trimpath -ldflags='-s -w' -o .deployment/payload/har-canvas ./cmd/server
```

构建后清除这三个临时环境变量，避免影响本地 Go 命令。上传目录应包含
`har-canvas`、`web/dist`、`deploy/har-canvas.service`，可选 `samples/re.har`。
另准备权限为 `600` 的环境文件，内容为：

```dotenv
HAR_CANVAS_USER=your-login-name
HAR_CANVAS_PASSWORD=replace-with-a-long-random-password
```

通过 SSH 将文件传到机器的私有暂存目录，然后执行：

```sh
sudo bash deploy/install.sh /absolute/path/to/payload /absolute/path/to/service.env release-name
instabox-port publish 8090 --name 'HAR Canvas' --json
```

安装器要求两个认证变量都存在，配置文件只有 root 可以读取。
服务额外启用 `-require-auth`，即使配置被清空也会拒绝启动，避免意外关闭认证。
应用只监听回环地址，公网 HTTPS 由 Instabox 提供。发布后应验证匿名请求返回
`401`，带正确凭据的 `/api/health` 返回 `{"status":"ok"}`。
默认 HAR 与全部静态文件、API 一起受登录保护。

管理命令：

```sh
sudo systemctl status har-canvas --no-pager
sudo journalctl -u har-canvas -n 50 --no-pager
sudo systemctl restart har-canvas
sudo systemctl stop har-canvas
instabox-port unpublish 8090
```

重新部署时使用新的版本名。旧版本保留，可将 `current` 切回旧目录后重启服务；
`shared` 中的登录信息与默认 HAR 是共用的，不随版本回滚。
重启机器后服务自动启动；机器暂停期间公网地址不可用。
