; The autostart entry is written by FORBY itself (HKCU, value "FORBY"); remove it on uninstall
!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "FORBY"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "FORBY"
!macroend
