// src/register.js
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { REST, Routes, SlashCommandBuilder } from "discord.js";

// Khai báo lại __dirname cho ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Chỉ định dotenv tìm file .env ở thư mục cha (gốc)
dotenv.config({ path: path.join(__dirname, "../.env") });
const commands = [
  // /traffic [location]
  new SlashCommandBuilder()
    .setName("traffic")
    .setDescription("Kiểm tra tình trạng giao thông tại một địa điểm")
    .addStringOption(option =>
      option.setName("location")
        .setDescription("Nhập tên địa điểm hoặc địa chỉ")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  // /check [origin] [destination]
  new SlashCommandBuilder()
    .setName("check")
    .setDescription("Kiểm tra kẹt xe lộ trình (AI Game Theory)")
    .addStringOption(option =>
      option.setName("origin")
        .setDescription("Điểm đi")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(option =>
      option.setName("destination")
        .setDescription("Điểm đến")
        .setRequired(true)
        .setAutocomplete(true)
    ),

  // /route [origin] [destination]
  new SlashCommandBuilder()
    .setName("route")
    .setDescription("Tìm lộ trình tối ưu và tính phí BOT/Phà")
    .addStringOption(option =>
      option.setName("origin")
        .setDescription("Điểm đi")
        .setRequired(true)
        .setAutocomplete(true)
    )
    .addStringOption(option =>
      option.setName("destination")
        .setDescription("Điểm đến")
        .setRequired(true)
        .setAutocomplete(true)
    ),
].map(command => command.toJSON());

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);

(async () => {
  try {
    console.log("⏳ Đang lấy Client ID từ Discord...");
    const user = await rest.get(Routes.user());
    const clientId = user.id;
    console.log(`✅ Đã nhận Client ID: ${clientId}`);

    console.log(`⏳ Đang đăng ký ${commands.length} lệnh Slash Commands (Global)...`);

    // Register globally (takes ~1 hour to show up everywhere, but usually instant in some cases)
    await rest.put(
      Routes.applicationCommands(clientId),
      { body: commands }
    );

    console.log("✅ Đã đăng ký Slash Commands thành công!");
    console.log("💡 Lưu ý: Lệnh mới có thể mất tới 1 giờ để xuất hiện trên Discord client.");
  } catch (error) {
    console.error("❌ Lỗi khi đăng ký commands:", error);
  }
})();
