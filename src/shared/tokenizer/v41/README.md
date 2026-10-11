# DeepSeek V4.1 tokenizer data

Source: deepseek-ai/DeepSeek-V4.1 on Hugging Face, revision
2cba9e42aa026125f3ed06c6d98c1db82f7ca027. The data is distributed under
the repository's MIT license; see LICENSE.

The browser client lazy-loads @huggingface/tokenizers and this compressed
vocabulary only when it needs to project a conversation. The tokenizer package
is MIT-licensed. The compressed vocabulary is 1,863,541 bytes; tokenizer JSON
SHA-256: 0b28eaf6f2682604a9cf49ad80225c983e0fd1d95be5cba3a98d1d26f8dc4b40.
Tokenizer config SHA-256:
6ac8c8dc065ed118161d02dd532749ae3f52c243deac27872134fae2f50d8547.

DeepSeek documents a 1,024-token post-resize image upper bound in its Vision guide: https://api-docs.deepseek.com/guides/vision. The client reserves that bound per image because image dimensions are not available synchronously during projection.\n\nThis is a client-side estimate, not an exact OpenRouter/provider prompt count:
provider prompt templates, image preprocessing, and fallback model tokenizers
can differ. The projection includes system instructions and text, adds an
image-token estimate, and leaves headroom. Actual usage returned by OpenRouter
should be used to calibrate and explain estimates. Do not present this estimate
as exact usage.
