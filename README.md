# dsh-pdf-sign

**PDF electronic signing for DeepSeek Harness (DSH)** — generate a handwritten-style signature image, stamp it on a PDF, and apply a real PKCS#7 digital signature.

**DeepSeek Harness 的 PDF 电子签名插件** —— 生成手写风格签名图、在 PDF 上盖章、并用你自己的证书做真正的 PKCS#7 数字签名。

[English](#english) · [中文](#中文)

---

## English

### What it does

Three capabilities, kept deliberately separate because they mean very different things:

| Tool | What it produces | Guarantee |
|---|---|---|
| `pdf_signature_image` | A handwritten-style signature image (PNG/SVG) from a name | none — it is artwork |
| `pdf_sign_stamp` | Ink placed on a PDF page (signature image and/or a typed block) | **visual only** |
| `pdf_sign_digital` | A PKCS#7/CMS detached signature over the whole file | **cryptographic** (`/ByteRange` + CMS) |
| `pdf_sign_cert_generate` | A self-signed certificate + `.p12` bundle for testing | none — self-signed |
| `pdf_sign_inspect` | Structural report of what signatures a PDF contains | inspection only |

The distinction matters: a stamped signature looks signed but proves nothing. A digital signature proves the document was not altered after signing and identifies who holds the key — but only a certificate from a real CA makes a reader display it as *trusted*.

### Install

```sh
dsh plugin --profile web add dsh-pdf-sign
```

Restart DSH, then the `pdf_sign_*` tools are available to the agent.

### Quick start

```
# 1. Make a signature image
pdf_signature_image(text="Juntao Xiao", output_path="/abs/path/sig.png")

# 2. Stamp it on the last page
pdf_sign_stamp(pdf_path="/abs/path/contract.pdf",
               image_path="/abs/path/sig.png",
               text="Juntao Xiao", date_text="2026-09-20",
               anchor="bottom-right", width=200)

# 3. Add a real digital signature
pdf_sign_cert_generate(common_name="Juntao Xiao", passphrase="secret",
                       output_dir="/abs/path/certs")
pdf_sign_digital(pdf_path="/abs/path/contract.pdf",
                 output_path="/abs/path/contract-signed.pdf",
                 p12_path="/abs/path/certs/signing-cert.p12",
                 passphrase="secret", reason="Approval")
```

### Tool reference

#### `pdf_signature_image`

| Parameter | Type | Notes |
|---|---|---|
| `text` | string, required | The signature text, usually the signer's name |
| `output_path` | string, required | Absolute path; `.png` (default) or `.svg` |
| `font_size` | number | Glyph size in px (default `120`) |
| `width` | number | Output PNG width in px |
| `color` | string | `blue-black`\|`black`\|`blue`\|`red`, `#rrggbb`, or `r,g,b` with 0–1 components |
| `rotation` | number | Whole-signature tilt in degrees (default `-2.5`) |
| `jitter` | number | Handwriting irregularity, `0` = perfectly straight (default `1`) |
| `underline` | boolean | Pen flourish under the signature (default `true`) |
| `letter_spacing` | number | Extra px between glyphs |
| `font_file` | string | Explicit font file; defaults to the best handwriting font found |
| `format` | `png`\|`svg` | Force the output format |

Each glyph is emitted as its own rotated, vertically jittered node using a **text-seeded** pattern — so the same name always produces the identical signature, which matters when a document is re-signed.

Best available fonts are auto-detected: 楷体/标楷体/华文行楷 on Windows, Songti/Kai on macOS, Noto Serif CJK/AR PL UKai on Linux.

#### `pdf_sign_stamp`

| Parameter | Type | Notes |
|---|---|---|
| `pdf_path` | string, required | Source PDF |
| `output_path` | string | Default `<name>-signed.pdf` beside the source |
| `image_path` | string | Signature image (PNG/JPEG) |
| `text` / `date_text` / `reason` | string | Typed block lines |
| `page` | number\|`"last"`\|`"all"` | Default `last` |
| `anchor` | enum | `top/middle/bottom` × `left/center/right`; default `bottom-right` |
| `x`, `y` | number | Explicit PDF-point origin, overriding `anchor` |
| `width` | number | Image width in points (default `180`) |
| `opacity` | number | 0–1 (default `1`) |
| `rotation` | number | Image rotation in degrees |
| `margin` | number | Edge margin in points (default `48`) |
| `font_size` | number | Text block size (default `10`) |
| `color` | string | `#rrggbb` or `r,g,b` |

Non-Latin text (Chinese, Japanese, Korean, …) is drawn with a **subset-embedded system TrueType font**, because pdf-lib's standard fonts are WinAnsi-only and cannot encode those characters at all.

#### `pdf_sign_digital`

| Parameter | Type | Notes |
|---|---|---|
| `pdf_path` | string, required | Source PDF |
| `p12_path` | string, required | Your PKCS#12 (`.p12`/`.pfx`) with the private key |
| `passphrase` | string | PKCS#12 passphrase (empty when unprotected) |
| `name` / `reason` / `location` / `contact_info` | string | Recorded in the signature |
| `signing_time` | string | ISO timestamp; defaults to now |
| `page` | number\|`"last"` | Page the widget sits on |
| `widget_rect` | number[4] | `[x1,y1,x2,y2]` widget rectangle in points |
| `sub_filter` | enum | `adbe.pkcs7.detached` (default) or `ETSI.CAdES.detached` |
| `signature_length` | number | Reserved placeholder bytes; raise it if signing reports a length error |

#### `pdf_sign_cert_generate`

Creates a self-signed certificate and `.p12`, or bundles an existing key + certificate pair (pass both `key_path` and `cert_path`). Requires OpenSSL; the bundled OpenSSL in Git for Windows is found automatically.

#### `pdf_sign_inspect`

Reports signature form fields, how many byte ranges are signed, the CMS sub-filter, and placeholder metadata. **Structural inspection only** — it does not verify cryptographic validity, which requires the signer's certificate chain.

### Security stance

- **Ships no keys, no CA, no trust anchor.** Nothing here can forge a signature that a reader would trust.
- Self-signed certificates produce signatures that validate as *intact* but display as *untrusted*. That is the correct and expected outcome; obtaining a CA-issued certificate is your job.
- Your private key and passphrase stay on your machine. The plugin does not transmit anything anywhere.
- Signing writes the placeholder **without object streams**, which is required for the incremental-update signing scheme — not a stylistic choice.

### Requirements

- Node.js ≥ 20
- OpenSSL, only for `pdf_sign_cert_generate` (auto-detected, including Git for Windows)
- Optional: the native `@resvg/resvg-js` binding for PNG rasterization. It ships as a dependency; if it cannot load on your platform, `pdf_signature_image` writes SVG instead and says so explicitly.

### Known limitations

- `pdf_sign_inspect` does not perform cryptographic verification, and does not consult a trust store.
- Encrypted PDFs are loaded with `ignoreEncryption`, so signing an encrypted document is not supported.
- Subset-embedded CJK fonts increase file size modestly (subset only, not the whole font).
- `ETSI.CAdES.detached` is offered, but only `adbe.pkcs7.detached` has been exercised end to end.

### License

MIT

---

## 中文

### 它做什么

五种能力，刻意分开——因为它们代表的东西完全不同：

| 工具 | 产出 | 保证 |
|---|---|---|
| `pdf_signature_image` | 手写风格签名图（PNG/SVG） | 无，它只是图像 |
| `pdf_sign_stamp` | 把签名盖到 PDF 页面上（签名图 和/或 文字块） | **仅视觉** |
| `pdf_sign_digital` | 覆盖整个文件的 PKCS#7/CMS 分离式签名 | **密码学保证**（`/ByteRange` + CMS） |
| `pdf_sign_cert_generate` | 自签名证书 + `.p12`（测试用） | 无，自签名 |
| `pdf_sign_inspect` | PDF 中签名结构的检查报告 | 仅结构检查 |

这个区分很关键：**盖章看起来像签了名，但什么都证明不了**；数字签名能证明文件在签名后未被改动、并标识持钥者身份——但只有来自真实 CA 的证书，PDF 阅读器才会显示为「受信任」。

### 安装

```sh
dsh plugin --profile web add dsh-pdf-sign
```

重启 DSH 后，agent 即可使用 `pdf_sign_*` 系列工具。

### 快速开始

```
# 1. 生成签名图
pdf_signature_image(text="肖俊涛", output_path="D:/sign/sig.png")

# 2. 盖到最后一页
pdf_sign_stamp(pdf_path="D:/contract.pdf",
               image_path="D:/sign/sig.png",
               text="肖俊涛", date_text="2026-09-20",
               anchor="bottom-right", width=200)

# 3. 加真正的数字签名
pdf_sign_cert_generate(common_name="肖俊涛", passphrase="你的口令",
                       output_dir="D:/sign/certs")
pdf_sign_digital(pdf_path="D:/contract.pdf",
                 output_path="D:/contract-signed.pdf",
                 p12_path="D:/sign/certs/signing-cert.p12",
                 passphrase="你的口令", reason="合同审批")
```

### 三个实现要点

1. **确定性签名**：每个字以独立的旋转+抖动节点渲染，抖动由**文本内容做种子**——同一个名字永远生成一模一样的签名，重复签署不会出现两种笔迹。
2. **中文文字盖章需要嵌入字体**：pdf-lib 的标准字体是 WinAnsi 编码，**无法编码任何中文**。插件会自动寻找系统中可嵌入的 TrueType 中文字体（楷体／黑体／仿宋／等线）并做子集嵌入。
3. **数字签名的占位符必须禁用对象流保存**（`useObjectStreams: false`），这是增量更新签名方案的硬性要求，不是代码风格选择。

### 安全立场

- **不内置任何密钥、CA 或信任锚**。这里没有任何东西能伪造出阅读器会信任的签名。
- 自签名证书产生的签名「完整性有效」但显示为「不受信任」——这是正确且预期的结果；取得 CA 签发的证书是你自己的事。
- 你的私钥与口令只留在本机，插件不向任何地方传输数据。

### 已知限制

- `pdf_sign_inspect` **不做密码学验证**，也不查询信任库。
- 加密 PDF 以 `ignoreEncryption` 方式加载，因此**不支持对加密文档签名**。
- `ETSI.CAdES.detached` 虽已提供，但只有 `adbe.pkcs7.detached` 经过端到端实测。
- 文本图章使用子集嵌入字体，会让 PDF 略微变大（只嵌入用到的字形，不是整个字体）。

### 许可

MIT

---

**本项目是 DeepSeek Harness 的社区插件，并非 DeepSeek 官方产品。**
本插件与 Adobe、OpenSSL 及任何证书颁发机构均无从属关系。
