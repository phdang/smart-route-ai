import { ciLabel } from '../src/engine.js';

const tests = [
  { ci: 0.9, expected: "🟢 Thông thoáng" },
  { ci: 1.0, expected: "🟢 Thông thoáng" },
  { ci: 1.05, expected: "🟡 Hơi đông" },
  { ci: 1.1, expected: "🟠 Đông xe" },
  { ci: 1.2, expected: "🟠 Đông xe" },
  { ci: 1.25, expected: "🔴 Kẹt xe" },
  { ci: 1.4, expected: "🔴 Kẹt xe" },
  { ci: 1.5, expected: "🚨 Kẹt nghiêm trọng" },
  { ci: 2.0, expected: "🚨 Kẹt nghiêm trọng" },
];

console.log("Verifying CI Labels:");
tests.forEach(({ ci, expected }) => {
  const actual = ciLabel(ci);
  console.log(`CI: ${ci.toFixed(2)} -> Actual: ${actual} | Expected: ${expected} | ${actual === expected ? "✅" : "❌"}`);
});
