# Shopify 图片中转工具 v1

一个用于以下流程的最小可运行图片中转 API：

`Google Sheets -> n8n -> 图片中转 API -> Wasabi S3 -> Shopify`

服务会下载第三方图片、检查真实二进制格式、自动旋转、缩放并重新编码为 JPEG，然后上传到 Wasabi，返回 Shopify 可公开抓取的稳定 URL。

## 功能

- Node.js + TypeScript + Fastify
- Node.js 22 原生 `fetch` 下载远程图片
- `file-type` 检测真实文件格式，不依赖 URL 后缀或远端 `Content-Type`
- Sharp 自动旋转并限制最长边为 2048px
- 优先使用 JPEG quality 82，超过 5MB 时逐步降低质量和尺寸
- SHA-256 内容哈希文件名，相同输出不会重复上传
- AWS SDK v3 `S3Client` 连接 Wasabi S3 兼容存储
- Bearer API Key 鉴权
- 下载超时、大小限制和重定向次数限制
- SSRF 防护：拦截 localhost、回环、私有、链路本地、CGNAT 和其他非公网 IP
- 每次重定向都重新执行协议、DNS 和公网 IP 校验
- 下载失败日志包含 URL、HTTP 状态码和底层错误消息
- Wasabi 对象使用 `.jpg`，并设置标准 HTTP 响应元数据
- Wasabi 对象上传时显式设置 `ACL: public-read`
- 上传后自动 GET 公开 URL，验证状态码、MIME 和 JPEG 魔数
- `GET /v1/images/check` 可诊断公开图片 URL

## 项目结构

```text
shopify-image-relay/
├── src/
│   ├── routes/
│   │   └── images.ts
│   ├── security/
│   │   ├── auth.ts
│   │   └── url-validator.ts
│   ├── services/
│   │   ├── downloader.ts
│   │   ├── image-processor.ts
│   │   ├── public-image-checker.ts
│   │   └── s3-storage.ts
│   ├── config.ts
│   ├── errors.ts
│   ├── server.ts
│   └── types.ts
├── tests/
│   ├── downloader.test.ts
│   ├── image-processor.test.ts
│   ├── public-image-checker.test.ts
│   ├── s3-storage.test.ts
│   ├── server.test.ts
│   └── url-validator.test.ts
├── .dockerignore
├── .env.example
├── .gitignore
├── Dockerfile
├── package.json
├── package-lock.json
├── tsconfig.json
└── README.md
```

## 运行要求

- Node.js 22 或更高版本
- Wasabi Bucket
- 对目标 Bucket 有读取、查询和上传对象权限的 Wasabi Access Key
- Bucket 中的 `images/` 路径可以公开读取

## Wasabi 配置

本项目默认使用：

```text
Bucket:   shopify-images-ckc
Region:   ap-northeast-1
Endpoint: https://s3.ap-northeast-1.wasabisys.com
```

Wasabi 官方区域列表中，`ap-northeast-1` 对应 Tokyo，服务地址为：

```text
s3.ap-northeast-1.wasabisys.com
```

复制环境变量文件：

```bash
cp .env.example .env
```

Windows PowerShell：

```powershell
Copy-Item .env.example .env
```

填写以下配置：

```dotenv
WASABI_ENDPOINT=https://s3.ap-northeast-1.wasabisys.com
WASABI_REGION=ap-northeast-1
WASABI_BUCKET=shopify-images-ckc
WASABI_ACCESS_KEY_ID=your-wasabi-access-key-id
WASABI_SECRET_ACCESS_KEY=your-wasabi-secret-access-key
WASABI_PUBLIC_BASE_URL=https://s3.ap-northeast-1.wasabisys.com/shopify-images-ckc
```

`WASABI_ENDPOINT` 用于 AWS SDK 上传和查询对象。

`WASABI_PUBLIC_BASE_URL` 只用于拼接返回给 Shopify 的公开 URL。以后接入 CDN 或自定义域名时，只需要更改这个变量。

对于 Wasabi 原生服务 URL，必须包含 Bucket 名：

```text
正确：https://s3.ap-northeast-1.wasabisys.com/shopify-images-ckc
错误：https://s3.ap-northeast-1.wasabisys.com
```

程序会清理末尾多余的 `/`，并避免生成重复斜杠。若 Wasabi URL 没有 Bucket 路径，程序会自动补上当前 `WASABI_BUCKET`；若路径中的 Bucket 名不匹配，启动时会报配置错误。

客户端使用：

- Wasabi 实际 region
- Wasabi 实际 endpoint
- AWS Signature V4
- Path-style S3 请求
- 仅在必要时发送或验证额外 checksum，提高 S3 兼容性

## 允许 Shopify 公开读取图片

上传凭据可以保持私密，但 Shopify 必须能够匿名读取生成的图片 URL。

上传使用 `ACL: public-read`。Wasabi Access Key 至少需要目标前缀的以下权限：

```text
s3:GetObject
s3:GetObjectAcl
s3:PutObject
s3:PutObjectAcl
```

建议只公开 `images/` 前缀。Bucket Policy 示例：

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadRelayImages",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::shopify-images-ckc/images/*"
    }
  ]
}
```

同时确认 Wasabi Console 中没有阻止该 Bucket 的 Public Access。测试公开访问：

```text
https://s3.ap-northeast-1.wasabisys.com/shopify-images-ckc/images/文件名.jpg
```

不要在这个 Bucket 中存储敏感文件。

如果 Bucket 或账户级设置禁止公开访问，`ACL: public-read` 仍可能被拒绝或不生效。此时需要在 Wasabi Console 允许 Public Access，并保留上述仅限 `images/*` 的 Bucket Policy。

## API Key

生成随机 API Key：

```bash
openssl rand -hex 32
```

Windows PowerShell：

```powershell
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower()
```

将结果写入 `.env`：

```dotenv
API_KEY=replace-with-a-long-random-secret
```

## 本地运行

```bash
npm install
npm run dev
```

服务默认运行在：

```text
http://localhost:3000
```

健康检查：

```bash
curl http://localhost:3000/health
```

`npm run dev` 会通过 `tsx` 自动读取根目录的 `.env`。也可以直接运行：

```bash
node --env-file=.env --import tsx src/server.ts
```

## API

### `POST /v1/images/relay`

请求头：

```http
Authorization: Bearer YOUR_API_KEY
Content-Type: application/json
```

请求体：

```json
{
  "url": "https://example.com/image.jpg"
}
```

成功响应：

```json
{
  "success": true,
  "url": "https://s3.ap-northeast-1.wasabisys.com/shopify-images-ckc/images/abc123.jpg",
  "format": "jpeg",
  "width": 1600,
  "height": 1600,
  "bytes": 300000
}
```

错误响应：

```json
{
  "success": false,
  "error": {
    "code": "UNSUPPORTED_IMAGE",
    "message": "Downloaded content is not a recognized image"
  }
}
```

远程下载失败时，Render 日志会包含类似字段：

```json
{
  "url": "https://example.com/image.jpg",
  "statusCode": 404,
  "errorCode": "REMOTE_HTTP_ERROR",
  "originalError": "REMOTE_HTTP_ERROR HTTP 404"
}
```

调用示例：

```bash
curl -X POST http://localhost:3000/v1/images/relay \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com/image.jpg"}'
```

relay 在上传完成后会立即 GET 返回的 Wasabi URL。只有以下条件同时满足时才返回成功：

- HTTP 状态为 `200`
- `Content-Type` 为 `image/jpeg`
- 文件前三个字节符合 JPEG 魔数 `ff d8 ff`

否则接口返回 `PUBLIC_IMAGE_VERIFICATION_FAILED`，Render 日志会包含公开 URL、响应头和 magic bytes，避免继续把无法处理的 URL 发给 Shopify。

失败响应会包含可安全复制到浏览器的 `debugPublicUrl`，但不会包含 Access Key、Secret 或签名：

```json
{
  "success": false,
  "error": {
    "code": "PUBLIC_IMAGE_VERIFICATION_FAILED",
    "message": "Public image verification failed: HTTP 403, content-type application/xml, JPEG magic 3c3f786d",
    "debugPublicUrl": "https://s3.ap-northeast-1.wasabisys.com/shopify-images-ckc/images/example.jpg"
  }
}
```

### `GET /v1/images/check`

检查一个公开图片 URL，不跟随重定向。该接口也需要相同的 Bearer API Key。

```bash
curl --get "https://你的中转服务域名/v1/images/check" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  --data-urlencode "url=https://s3.ap-northeast-1.wasabisys.com/shopify-images-ckc/images/example.jpg"
```

示例响应：

```json
{
  "success": true,
  "url": "https://s3.ap-northeast-1.wasabisys.com/shopify-images-ckc/images/example.jpg",
  "httpStatus": 200,
  "contentType": "image/jpeg",
  "contentLength": 300000,
  "cacheControl": "public, max-age=31536000, immutable",
  "contentDisposition": "inline",
  "magicBytes": [255, 216, 255, 224, 0, 16],
  "magicBytesHex": "ffd8ffe000104a46494600010200000100010000",
  "responsePreview": null,
  "isJpeg": true
}
```

如果 Wasabi 返回 XML 权限错误、HTML 页面或 3xx 重定向，`httpStatus`、`contentType`、magic bytes 和 `isJpeg` 会直接显示实际结果。`responsePreview` 会包含响应体前 500 个字符，例如 `AccessDenied` 或 `NoSuchKey`。

## 图片处理规则

1. 下载上限默认 15MB，由 `MAX_DOWNLOAD_BYTES` 配置。
2. 下载超时默认 15 秒，由 `DOWNLOAD_TIMEOUT_MS` 配置。
3. 使用 Node.js 22 原生 `fetch`，并发送浏览器风格的图片请求头。
4. 重定向由应用手动处理，每次跳转后重新执行协议、DNS 和公网 IP 校验。
5. 使用 `file-type` 从二进制内容识别图片。
6. 使用 Sharp 解码验证、读取 EXIF 方向并自动旋转。
7. 最长边限制为 2048px，不放大小图片。
8. 去除原始元数据，透明区域使用白色背景。
9. 输出 sRGB JPEG，初始 quality 82。
10. 超过 5MB 时逐步降低质量，必要时继续降低尺寸。
11. 对最终 JPEG 计算 SHA-256，保存为 `images/<sha256>.jpg`。
12. 上传 key 固定为 `images/<sha256>.jpg`。
13. `PutObjectCommand` 顶层设置：

```text
ContentType: image/jpeg
ContentDisposition: inline
CacheControl: public, max-age=31536000, immutable
ACL: public-read
```

这些是 S3 对象的标准 HTTP 响应元数据，不放在自定义 `Metadata` 字段中。

14. 已存在的哈希对象会通过 `HeadObject` 检查上述元数据；不正确时自动覆盖上传。
15. 上传后立即检查公开 URL，确认 Shopify 获取到的是 JPEG 二进制而非 XML、HTML 或重定向响应。

## 测试与构建

```bash
npm run typecheck
npm test
npm run build
npm start
```

## Docker 部署

构建：

```bash
docker build -t shopify-image-relay .
```

运行：

```bash
docker run --rm \
  --env-file .env \
  -p 3000:3000 \
  shopify-image-relay
```

PowerShell：

```powershell
docker run --rm --env-file .env -p 3000:3000 shopify-image-relay
```

## 部署到 Render

推荐使用 Docker：

1. 将项目推送到 GitHub。
2. Render 选择 `New -> Web Service` 并连接仓库。
3. Runtime 选择 `Docker`。
4. 添加 `.env.example` 中的环境变量，不要上传真实 `.env`。
5. Health Check Path 设置为 `/health`。
6. Render 会自动注入 `PORT`，应用会监听该端口。

原生 Node 模式：

- Build Command：`npm ci && npm run build`
- Start Command：`node dist/server.js`

## 部署到 Railway

1. 将项目推送到 GitHub。
2. Railway 创建 Project，选择 `Deploy from GitHub repo`。
3. Railway 会检测根目录的 Dockerfile。
4. 在 Variables 中添加 `.env.example` 的配置。
5. 在 Networking 中生成公开域名。
6. Healthcheck Path 设置为 `/health`。

不用 Docker 时：

- Build Command：`npm ci && npm run build`
- Start Command：`node dist/server.js`

## n8n HTTP Request 节点

n8n 调用格式保持不变。假设当前 item 的单张图片地址字段为 `imageUrl`：

- Method：`POST`
- URL：`https://你的中转服务域名/v1/images/relay`
- Authentication：`None`
- Send Headers：开启
- Header Name：`Authorization`
- Header Value：`Bearer {{$env.IMAGE_RELAY_API_KEY}}`
- Send Body：开启
- Body Content Type：`JSON`
- Specify Body：`Using JSON`

JSON Body：

```json
{
  "url": "{{$json.imageUrl}}"
}
```

建议工作流：

```text
Google Sheets
-> Code/Edit Fields 拆分 Image_URLs
-> Split Out
-> Loop Over Items
-> HTTP Request 调用中转 API
-> Aggregate 汇总返回的 url
-> Shopify GraphQL Admin API
-> 回写 Google Sheets
```

Shopify 媒体参数继续使用接口返回的 `url`：

```json
{
  "mediaContentType": "IMAGE",
  "originalSource": "{{$json.url}}"
}
```

HTTP Request 节点建议：

- Timeout 设置为 `30000` 至 `60000` 毫秒。
- Retry On Fail 开启，最多重试 2 至 3 次。
- 批量处理时控制并发，避免同时下载过多大图。

## 生产注意事项

- 不要把 `API_KEY` 或 Wasabi Secret 写进 n8n 工作流 JSON、Google Sheets 或 Git。
- Wasabi Access Key 只授予目标 Bucket 所需的最小权限。
- 公开读取策略尽量限制在 `images/*`。
- 图片是给 Shopify 抓取的，必须能通过无登录的 HTTPS URL 访问。
- 如果接口暴露到公网，建议在部署平台或反向代理增加速率限制。
- 某些货源站要求 Cookie、Referer、登录态或有强防盗链。本 v1 不绕过这些访问控制，此类 URL 会返回下载错误。

## 官方参考

- Wasabi 区域服务地址：https://docs.wasabi.com/docs/service-urls-for-wasabis-storage-regions
- Wasabi AWS SDK for JavaScript：https://docs.wasabi.com/docs/how-do-i-use-aws-sdk-for-javascript-with-wasabi
- Wasabi Public Access：https://docs.wasabi.com/docs/public-access-enabledisable
