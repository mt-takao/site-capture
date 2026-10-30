import sharp from 'sharp';

// 一覧（V-02）に使うサムネイル。幅をそろえ、ページの上端から切り出して WebP で保存する
const THUMB_WIDTH = 400;
const THUMB_MAX_HEIGHT = 600;

export async function makeThumbnail(sourcePath: string, thumbPath: string): Promise<void> {
  const resized = await sharp(sourcePath).resize({ width: THUMB_WIDTH }).png().toBuffer({ resolveWithObject: true });
  await sharp(resized.data)
    .extract({ left: 0, top: 0, width: resized.info.width, height: Math.min(THUMB_MAX_HEIGHT, resized.info.height) })
    .webp({ quality: 80 })
    .toFile(thumbPath);
}
