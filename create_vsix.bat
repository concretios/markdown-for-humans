@echo off
echo Building and packaging the extension into a .vsix file...
npm run package:release
echo Moving .vsix into dist\ ...
for %%f in (*.vsix) do move /Y "%%f" "dist\" >nul
echo Done!
pause
