<?php
/**
 * wp-media-proxy.php
 * Netlify Functions からの画像アップロードを WordPress に中継するプロキシ。
 * このファイルを WordPress ルート（wp-config.php と同じ階層）に設置すること。
 *
 * Netlify 環境変数:
 *   WP_PROXY_URL   = https://maruhane.net/wp-media-proxy.php
 *   WP_PROXY_TOKEN = 下記 PROXY_SECRET_TOKEN と同じ値
 */

// ★ここを変更する: Netlify の WP_PROXY_TOKEN 環境変数と同じ値を設定
define('PROXY_SECRET_TOKEN', 'your-secret-token-here');

// WordPress にログインするユーザー名（管理者権限を持つアカウント）
define('PROXY_WP_USERNAME', 'maruhane');

header('Content-Type: application/json; charset=utf-8');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    exit(json_encode(['error' => 'Method Not Allowed']));
}

$token = $_SERVER['HTTP_X_PROXY_TOKEN'] ?? '';
if (!hash_equals(PROXY_SECRET_TOKEN, $token)) {
    http_response_code(403);
    exit(json_encode(['error' => 'Forbidden']));
}

$imageData = file_get_contents('php://input');
if (empty($imageData)) {
    http_response_code(400);
    exit(json_encode(['error' => 'No image data']));
}

$filename = basename($_SERVER['HTTP_X_FILENAME'] ?? ('farm-' . time() . '.jpg'));
// ファイル名をサニタイズ（英数字・ハイフン・ドットのみ許可）
$filename = preg_replace('/[^a-zA-Z0-9\-_\.]/', '', $filename);
if (empty($filename)) {
    $filename = 'farm-' . time() . '.jpg';
}

require_once __DIR__ . '/wp-load.php';

$user = get_user_by('login', PROXY_WP_USERNAME);
if (!$user) {
    http_response_code(500);
    exit(json_encode(['error' => 'WordPress user not found: ' . PROXY_WP_USERNAME]));
}
wp_set_current_user($user->ID);

$tmpFile = wp_tempnam($filename);
file_put_contents($tmpFile, $imageData);

$fileArray = [
    'name'     => $filename,
    'type'     => 'image/jpeg',
    'tmp_name' => $tmpFile,
    'error'    => 0,
    'size'     => strlen($imageData),
];

$mediaId = media_handle_sideload($fileArray, 0);
@unlink($tmpFile);

if (is_wp_error($mediaId)) {
    http_response_code(500);
    exit(json_encode(['error' => $mediaId->get_error_message()]));
}

echo json_encode([
    'id'         => $mediaId,
    'source_url' => wp_get_attachment_url($mediaId),
]);
