-- Gen Medi for Mac: stay-open applet that runs the local AI server (no Terminal window)
on run
	set appPath to POSIX path of (path to me)
	set res to appPath & "Contents/Resources/"
	try
		do shell script "xattr -dr com.apple.quarantine " & quoted form of appPath
	end try
	do shell script "cd " & quoted form of res & " && (nohup ./python/bin/python3 genmedi/launcher.py >> /tmp/genmedi-launcher.log 2>&1 &); echo ok"
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
