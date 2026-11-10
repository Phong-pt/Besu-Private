**Thiết kế mạng Besu xác minh học vấn, chứng chỉ và quá trình làm việc**  
**Tổng quan dự án**  
Dự án xây dựng mạng consortium blockchain trên Hyperledger Besu, cho phép các trường học, đơn vị cấp chứng chỉ và doanh nghiệp thành lập liên minh để cùng quản lý, phát hành và xác minh hồ sơ học vấn, chứng chỉ và quá trình làm việc.  
Mỗi tổ chức chịu trách nhiệm xác nhận thông tin thuộc thẩm quyền của mình. Cá nhân nhận hồ sơ và quyết định chia sẻ với bên xác minh trong phạm vi, thời hạn đã chấp thuận.  
Du_An.md là tài liệu đặc tả chi tiết. Mã smart contract nằm trong contracts/src/.  
**Tech stack**  
| | |  
|-|-|  
| **Công nghệ** | **Vai trò** |   
| Solidity | Viết smart contract quản lý tổ chức, quyền phát hành, credential, consent và quản trị liên minh |   
| Hyperledger Besu | Vận hành mạng blockchain consortium với cơ chế đồng thuận QBFT |   
| PostgreSQL | Lưu dữ liệu nghiệp vụ ngoài chain, liên kết tài khoản và danh tính, chỉ mục tra cứu và nhật ký ứng dụng |   
   
Smart contract hiện sử dụng Solidity 0.8.24 và import OpenZeppelin Contracts 5.0.2.  
**Mục đích**  
- Tạo nền tảng để các tổ chức cùng tham gia một liên minh quản lý và xác minh hồ sơ.  
- Hỗ trợ chống làm giả bằng cấp, chứng chỉ và xác nhận quá trình làm việc bằng cách kiểm tra nguồn phát hành và tính toàn vẹn dữ liệu.  
- Hỗ trợ chống giả dạng, sử dụng hồ sơ của người khác thông qua liên kết danh tính và bằng chứng kiểm soát khóa của chủ thể.  
- Giúp xác minh hồ sơ của cá nhân, nhân viên và sinh viên dựa trên thông tin do tổ chức có thẩm quyền phát hành.  
- Theo dõi trạng thái hết hạn, thu hồi và thay thế hồ sơ.  
- Bảo vệ quyền riêng tư bằng cách giới hạn dữ liệu đưa lên blockchain và kiểm soát quyền chia sẻ hồ sơ ngoài chain.  
**Vai trò tham gia**  
| | |  
|-|-|  
| **Vai trò** | **Trách nhiệm** |   
| Tổ chức phát hành — Issuer | Trường học cấp bằng, đơn vị chứng chỉ cấp chứng nhận, doanh nghiệp xác nhận quá trình làm việc |   
| Chủ thể hồ sơ — Holder | Nhận hồ sơ, chứng minh liên kết chủ thể và cấp hoặc thu hồi chấp thuận chia sẻ |   
| Bên xác minh — Verifier | Xác minh hồ sơ trong phạm vi được chủ thể cho phép |   
| Hội đồng quản trị | Phê duyệt tổ chức, quyền phát hành và các thay đổi quản trị liên minh |   
| Validator | Tham gia đồng thuận, xác nhận giao dịch và block của mạng Besu |   
   
**Nguyên tắc dữ liệu và quyền riêng tư**  
- **On-chain:** lưu bằng chứng mật mã, tham chiếu chủ thể dạng giả danh, nguồn phát hành, quyền nghiệp vụ, trạng thái hồ sơ, consent và lịch sử quản trị.  
- **Off-chain:** lưu thông tin cá nhân, nội dung hồ sơ, bản scan và dữ liệu dùng để tính bằng chứng. Hồ sơ nhạy cảm phải được mã hóa và chỉ cung cấp sau khi kiểm tra quyền truy cập.  
- PostgreSQL phục vụ dữ liệu nghiệp vụ và chỉ mục; tài liệu mã hóa được lưu trong object storage, khóa mã hóa được quản lý qua KMS hoặc Vault theo đặc tả.  
- Không đưa dữ liệu cá nhân dạng rõ, payload hồ sơ, salt, private key hoặc khóa mã hóa vào smart contract, transaction calldata hay event.  
- Không coi private blockchain là cơ chế tự động giữ bí mật giữa các tổ chức vận hành node. Metadata trên chain vẫn có thể bị đọc và liên kết.  
- Consent kiểm soát việc hệ thống tiếp tục cung cấp dữ liệu ngoài chain; không thể thu hồi bản sao mà bên nhận đã tải trước đó.  
- Không dùng chỉ mục PostgreSQL đã lỗi thời để kết luận hồ sơ còn hiệu lực hoặc cấp quyền truy cập.  
**Smart contract hiện có**  
| | |  
|-|-|  
| **Contract** | **Chức năng** |   
| ConsortiumGovernance.sol | Quản trị ứng dụng theo cơ chế phê duyệt 3/5 |   
| OrganizationRegistry.sol | Quản lý tổ chức, trạng thái, khóa issuer và phạm vi phát hành |   
| SchemaRegistry.sol | Quản lý định nghĩa, phiên bản và chính sách của từng loại hồ sơ |   
| SubjectRegistry.sol | Quản lý liên kết chủ thể–khóa, thay khóa và khôi phục |   
| CredentialRegistry.sol | Phát hành, thu hồi, thay thế và tra cứu trạng thái credential |   
| ConsentRegistry.sol | Quản lý chấp thuận chia sẻ theo chủ thể, bên nhận, phạm vi và thời hạn |   
| base/Governed.sol | Lớp cơ sở giới hạn quyền quản trị từ governance |   
   
Quản trị ứng dụng 3/5 độc lập với đồng thuận QBFT. Blockchain ghi nhận lời xác nhận và lịch sử của tổ chức phát hành; không tự chứng minh thông tin ngoài đời là đúng. Dự án vẫn cần đối chiếu danh tính, kiểm tra hồ sơ nguồn, công nhận tổ chức và xử lý tranh chấp.  
**Hướng dẫn làm việc trong repository**  
- Đọc Du_An.md và mã nguồn liên quan trước khi thay đổi nghiệp vụ.  
- Tập trung vào phạm vi người dùng yêu cầu; giữ cấu trúc dự án gọn.  
- Không tự tạo thêm thư mục test, README, file JSON, bộ công cụ build hoặc cài dependency nếu chưa được yêu cầu.  
- Hiện tại người dùng sẽ tự kiểm thử luồng. Không tự chạy bộ test hoặc mở rộng kiểm thử khi chưa có yêu cầu mới.  
- Không tự deploy lên mạng Besu hoặc thay đổi cấu hình mạng khi chưa được yêu cầu.  
- Giữ nguyên tài liệu gốc và các file ngoài phạm vi thay đổi.  
- Nêu rõ phần đã viết, phần đã kiểm tra và phần chưa kiểm tra; không coi mã đã viết là hệ thống đã nghiệm thu.  
- không commit nhữn file riêng tư, quan trọng như env , file chứa password thì phải ẩn đi, file chứa api key lên github

**Vận hành hiện tại: một container**

- Clone nhánh `Network`; máy mới dùng `docker compose up -d --build`, các lần sau dùng `docker compose up -d` tại gốc repository; container `besu-system`, image `besu-system:local`. Không chạy thêm backend, database hoặc mạng trên host. Hướng dẫn tại `Huong_Dan.md`.
- Một container chứa PostgreSQL 17, bốn cặp Besu 26.10.2 + Teku, Node 24.22.2, ứng dụng/API, Dora và Blockscout. Chain local PoS 20261104 có 64 validator interop; thiết kế nghiệp vụ gốc vẫn mô tả consortium QBFT.
- Giao diện `http://localhost:3002`, Dora `http://localhost:8080`, Blockscout `http://localhost:8081`; API trạng thái cổng 3000 yêu cầu Bearer token. Chỉ publish loopback.
- Volume `besu-system-data` mount `/data` giữ database, genesis, khóa, bản mã, giao dịch, deployment và token. Không xóa volume để khởi động lại. Không đóng gói secret vào image hoặc commit. Các tên lưu trữ `business-demo`, bảng `demo_*` và miền chữ ký cũ được giữ để tương thích dữ liệu.
- Backend chính: `backend/app.cjs`, `runtime.cjs`, `indexer.cjs`, `policy.cjs`; SQL `database/schema.sql`, `index.sql`. Truy cập PostgreSQL qua socket nội bộ, không gọi Docker từ backend.
- Container tự khởi tạo khi volume trống, tiếp tục dữ liệu khi khởi động lại; không tự reset chain hay thay khóa. Entrypoint quản lý thứ tự khởi động/dừng và healthcheck. Không chạy hai container cùng volume hoặc cùng bộ validator.
- Operator token nằm ở `/data/network/business-demo/operator-token`; API token ở `/data/network/status-api-token`. Không in token/khóa trong báo cáo. Chỉ dùng dữ liệu giả: chưa có ví người dùng độc lập, KMS/object storage tách máy hay đăng nhập production.
- Đã xóa tài liệu/kịch bản demo rời và báo cáo testcase theo yêu cầu. Không tái tạo báo cáo testcase hoặc frontend 3D nếu chưa được yêu cầu.
- Các mục vận hành cũ trong `Du_An.md` là lịch sử triển khai; hướng dẫn hiện hành ở mục 21.11 và `Huong_Dan.md`.

- Build dùng nguồn công khai đã ghim trong Dockerfile; không phụ thuộc `container/.assets` hay Downloads. Không commit `.env`, token, mật khẩu, khóa, volume hoặc bản backup. Mỗi clone tự tạo secret và dữ liệu mẫu riêng.
