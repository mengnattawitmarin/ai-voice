-- Gen Medi for Mac: stay-open applet that runs the local AI server (no Terminal window)
on run
	set appPath to POSIX path of (path to me)
	set res to appPath & "Contents/Resources/"
	try
		do shell script "xattr -dr com.apple.quarantine " & quoted form of appPath
	end try
	do shell script "echo '--- start' $(date) >> /tmp/genmedi-launcher.log; cd " & quoted form of res & " && (nohup ./python/bin/python3 genmedi/launcher.py >> /tmp/genmedi-launcher.log 2>&1 &); echo ok"
	-- check that it really started; if not, show the error so the user can send it
	set serverUp to false
	repeat 40 times
		delay 0.5
		try
			do shell script "curl -s -m 1 -o /dev/null http://127.0.0.1:7861/"
			set serverUp to true
			exit repeat
		end try
	end repeat
	if not serverUp then
		set logText to do shell script "tail -n 25 /tmp/genmedi-launcher.log 2>/dev/null; echo; tail -n 15 \"$HOME/Library/Application Support/GenMedi/logs/setup.log\" 2>/dev/null; true"
		set the clipboard to logText
		display dialog "Gen Medi เปิดเซิร์ฟเวอร์ไม่สำเร็จ (คัดลอกข้อความนี้ไว้ในคลิปบอร์ดแล้ว — วางส่งให้ผู้พัฒนาได้เลย)" & return & return & logText buttons {"ปิด"} default button 1 with icon caution
	end if
end run

on reopen
	do shell script "open http://localhost:7861/"
end reopen

on quit
	try
		do shell script "pkill -f 'genmedi/launcher.py'; pkill -f 'genmedi_server.py'; pkill -f 'cloudflared tunnel --no-autoupdate'; true"
	end try
	continue quit
end quit
