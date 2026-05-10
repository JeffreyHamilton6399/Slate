@echo off
cd /d D:\Slate\Slate
git add patches.js
git status
git commit -m "Detachable panels, host audio mute, iOS vis toggle, draw-mute full block"
git push origin main
echo DONE
pause
