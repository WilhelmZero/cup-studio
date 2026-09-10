# Scene Studio 雕刻预览联动

Scene Studio 的“高质量3D预览”将当前雕刻用图交给 https://wilhelmzero.github.io/cup-studio/ 。自动使用默认透明玻璃杯，打开贴图面板，以白色磨砂表现雕刻区域；黑色透明，灰度表达覆盖程度。路径追踪渐进收敛，拖动后重新细化，不调用 AI。

外部会话不恢复或覆盖默认草稿，可以手动保存项目。图片按毫米尺寸居中、保持比例，超过可用区域等比缩小并提示。普通导入可选“雕刻贴图”；旧项目缺少 design.engraving 时按 false 处理，保存后保留该布尔字段。

## 协议

URL 仅含 engravingPreview=1 与随机 session。postMessage 数据为 {bridge:'engraving-preview-v1', session, type, payload?}；hello → ready → image → applied，失败返回 error。applied 仅在图片解码和场景贴图应用后发送，不等待渐进采样完成。重复 image 不重复导入。双方验证窗口、origin、会话；接收端允许 https://wilhelmzero.github.io，本地调试额外允许 5179 端口。120 秒未完成提示重试或下载手动导入。

payload 包含 PNG Blob、name、width、height、widthMm、heightMm、dpi、mode（dither/grayscale）。PNG 最大20MiB、4000万像素，DPI 72–1200；毫米尺寸须与像素/DPI一致。实际解码尺寸必须匹配。传输仅发生在浏览器窗口间，不把图片写入 URL 或上传服务器。

## 验证

在源码仓库运行：

```sh
node --experimental-loader ./scripts/viewer-test-loader.mjs --test tests/engraving.test.mjs
```

线上仓库 main 根目录对应源码 viewer/，通过 GitHub Pages 分支发布。
