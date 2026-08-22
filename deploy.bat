@echo off
echo Building project...
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo Build failed!
    exit /b %ERRORLEVEL%
)
echo Deploying to Vercel...
call npx vercel deploy --prod --yes
if %ERRORLEVEL% NEQ 0 (
    echo Deployment failed!
    exit /b %ERRORLEVEL%
)
echo Done!
