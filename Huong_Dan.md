# Chạy hệ thống

Máy mới cần Git, Docker Engine/Docker Desktop và Docker Compose v2. Image hiện dành cho Linux x86_64; Docker Desktop cần cấp đủ RAM cho bốn cặp Besu/Teku (khuyến nghị 8 GB trở lên). Lần build đầu cần Internet để tải runtime/dependency và biên dịch Teku.

```bash
git clone --branch Network --single-branch https://github.com/Phong-pt/Besu-Private.git
cd Besu-Private
docker compose up -d --build
```

Không cần xin `.env`, password, private key, thư mục `.local` hay runtime từ máy khác. Dockerfile tự lấy các image theo digest, kiểm tra SHA-256 cho archive và build Teku từ commit đã ghim. Khi volume trống, container sinh genesis, khóa, token và mật khẩu mới, triển khai sáu contract rồi tạo dữ liệu mẫu riêng.

Một container `besu-system` chạy toàn bộ mạng Besu/Teku, PostgreSQL, ứng dụng, Dora và Blockscout. Chờ trạng thái `healthy` trong `docker compose ps` trước khi sử dụng. Lần khởi tạo đầu cần vài phút; có thể theo dõi bằng `docker compose logs -f`. Container chỉ báo sẵn sàng khi finality của cả bốn node đã gần hiện tại.

Trên máy đã có image và dữ liệu, dùng `docker compose up -d` hoặc `docker start besu-system`.

| Dịch vụ | Địa chỉ |
|---|---|
| Giao diện nghiệp vụ | http://localhost:3002 |
| Dora | http://localhost:8080 |
| Blockscout | http://localhost:8081 |
| API trạng thái có xác thực | http://localhost:3000 |

Lấy token để đăng nhập giao diện trên terminal của bạn:

```bash
docker exec besu-system cat /data/network/business-demo/operator-token
```

API cổng 3000 dùng token riêng tại `/data/network/status-api-token`. Giữ kín các token này.

```bash
docker stop -t 180 besu-system  # dừng an toàn
docker start besu-system       # lần sau chỉ cần lệnh này
docker compose ps             # trạng thái
docker compose logs --tail 30  # tiến độ khởi động
```

Volume `besu-system-data` giữ chain, database, hồ sơ mã hóa, khóa và token. `docker compose down` giữ volume; **không dùng `down -v`** nếu muốn giữ dữ liệu. Không cần chạy Java, Node, PostgreSQL hoặc explorer trên host. Các cổng chỉ mở trên localhost.

# Build lại và chuyển máy

Mã build nằm ở `Dockerfile`, `container/` và `compose.yaml`. Chạy `docker compose up -d --build` sau khi cập nhật mã. Không cần cài Java, Node, Besu, Teku hoặc Dora trên host. Dependency JavaScript được ghim trong `container/package-lock.json`.

Clone mới tạo mạng và dữ liệu mẫu riêng, không mang theo 22 hồ sơ, token, mật khẩu hoặc khóa của máy phát triển. Các tên lưu trữ `business-demo` và bảng `demo_*` được giữ để tương thích; các file demo rời/báo cáo testcase không được đưa lên Git.

Nếu chuyển đúng dữ liệu hiện có sang máy khác, sao lưu/phục hồi **toàn bộ volume khi container đã dừng**, bao gồm journal database và khóa. Bản sao này chứa thông tin riêng tư: chuyển qua kênh riêng, không đẩy lên GitHub. Không chạy hai bản sao cùng bộ validator.

Đây là môi trường trình diễn local với dữ liệu giả và ví được backend quản lý. Việc gom container không biến hệ thống thành bản production.
