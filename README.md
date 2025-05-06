# Co-Design Canvas

A collaborative design tool that allows multiple users to work together on architectural and urban design projects in real-time. The application features a canvas where users can draw, upload images, and generate AI-enhanced designs using ComfyUI.

## Prerequisites

Before you begin, ensure you have the following installed:
- Python 3.8 or higher
- Node.js and npm (for frontend dependencies)
- ComfyUI (for AI image generation)
- Git

## Installation

### First Time Setup (After Receiving the Zip File)

1. Extract the zip file to your desired location:
```bash
# Windows
Right-click the zip file and select "Extract All..."

# macOS/Linux
unzip co-design-canvas.zip
```

2. Navigate to the extracted directory:
```bash
cd co-design-canvas
```

3. Create a `.env` file from the template:
```bash
# Windows
copy .env.example .env

# macOS/Linux
cp .env.example .env
```

4. Edit the `.env` file and add your API keys:
```env
OPENAI_API_KEY=your_openai_api_key
HUGGING_FACE_API_KEY=your_huggingface_api_key
FIREBASE_PROJECT_ID=your_project_id
FIREBASE_STORAGE_BUCKET=your_storage_bucket
```

5. Set up Firebase:
   - Create a Firebase project at [Firebase Console](https://console.firebase.google.com/)
   - Download your `serviceAccountKey.json` and place it in the project root
   - Update the Firebase configuration in `app.py` with your project details

### Complete Installation Steps

1. Create and activate a virtual environment:
```bash
# Windows
python -m venv venv
.\venv\Scripts\activate

# macOS/Linux
python3 -m venv venv
source venv/bin/activate
```

2. Install Python dependencies:
```bash
pip install -r requirements.txt
```

3. Install ComfyUI:
   - Download ComfyUI from [ComfyUI GitHub](https://github.com/comfyanonymous/ComfyUI)
   - Follow their installation instructions
   - Place ComfyUI in a known location (default: `C:\Users\username\OneDrive\Documents\ComfyUI\ComfyUI_windows_portable\ComfyUI`)

4. Update ComfyUI paths in `app.py`:
```python
COMFYUI_API_URL = "http://127.0.0.1:8188"
COMFYUI_MODELS_PATH = "path/to/your/ComfyUI/models"
COMFYUI_OUTPUT_PATH = "path/to/your/ComfyUI/output"
```

## Required Python Packages

The following packages are required and will be installed via `requirements.txt`:

```
flask==2.0.1
flask-socketio==5.1.1
python-dotenv==0.19.0
firebase-admin==5.0.3
openai==0.27.0
requests==2.26.0
Pillow==8.3.1
pyngrok==5.1.0
reportlab==3.6.1
wordcloud==1.8.1
matplotlib==3.4.3
numpy==1.21.2
```

## Running the Application

1. Start ComfyUI:
```bash
# Navigate to your ComfyUI directory
cd path/to/ComfyUI
python main.py
```

2. In a new terminal, start the Flask application:
```bash
# Activate virtual environment if not already activated
.\venv\Scripts\activate  # Windows
source venv/bin/activate  # macOS/Linux

# Start the Flask server
python app.py
```

3. Access the application:
   - Open your web browser
   - Navigate to `http://localhost:3000`

## Features

- Real-time collaborative canvas
- Multiple user support with unique colors
- Image upload and generation
- AI-powered design analysis
- PDF report generation
- Firebase integration for data persistence
- WebSocket communication for real-time updates

## Project Structure

```
co-design-canvas/
├── app.py                 # Main Flask application
├── requirements.txt       # Python dependencies
├── .env                  # Environment variables
├── serviceAccountKey.json # Firebase credentials
├── assets/              # Static assets
├── templates/           # HTML templates
└── submissions.csv      # Local storage for submissions
```

## Configuration

### ComfyUI Settings
Update the following paths in `app.py` to match your ComfyUI installation:
```python
COMFYUI_API_URL = "http://127.0.0.1:8188"
COMFYUI_MODELS_PATH = "path/to/your/ComfyUI/models"
COMFYUI_OUTPUT_PATH = "path/to/your/ComfyUI/output"
```

### Firebase Configuration
Update the Firebase configuration in `app.py`:
```python
project_id = "your-project-id"
storage_bucket = "your-storage-bucket"
```

## Troubleshooting

1. ComfyUI Connection Issues:
   - Ensure ComfyUI is running on port 8188
   - Check if the paths in `app.py` match your ComfyUI installation
   - Verify model files are present in the ComfyUI models directory

2. Firebase Issues:
   - Verify `serviceAccountKey.json` is in the correct location
   - Check Firebase project configuration
   - Ensure Firebase storage bucket is properly set up

3. WebSocket Connection Issues:
   - Check if port 3000 is available
   - Verify firewall settings
   - Check browser console for connection errors

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## Creating a Distributable Package

To create a distributable package of the project:

1. Create a `.env` file from the template:
```bash
cp .env.example .env
```

2. Update the `.env` file with your own API keys and configuration:
```env
OPENAI_API_KEY=your_openai_api_key
HUGGING_FACE_API_KEY=your_huggingface_api_key
FIREBASE_PROJECT_ID=your_project_id
FIREBASE_STORAGE_BUCKET=your_storage_bucket
```

3. Create a zip file excluding sensitive information:
```bash
# Windows
powershell Compress-Archive -Path * -DestinationPath co-design-canvas.zip -Force

# macOS/Linux
zip -r co-design-canvas.zip . -x "*.git*" "*.env" "serviceAccountKey.json" "venv/*" "__pycache__/*" "*.pyc" "*.pyo" "*.pyd" ".Python" "*.so" "*.egg" "*.egg-info" "dist" "build" "*.log" "submissions.csv" "temp_*.png" "output/*" "*.pdf"
```

### File Checklist

The zip file should include:

#### Core Application Files
- [ ] app.py
- [ ] index.html
- [ ] script.js
- [ ] styles.css
- [ ] text-standardization.css
- [ ] Inpaint_Anything.json

#### Configuration Templates
- [ ] config.template.js
- [ ] config.template.py
- [ ] firebase-config.template.js
- [ ] .env.example

#### Documentation and Setup
- [ ] README.md
- [ ] requirements.txt
- [ ] .gitignore

#### Assets
- [ ] assets/images/ (all images)

#### Additional HTML Files
- [ ] thematic_analysis.html
- [ ] architecture_visualization.html
- [ ] survey-analysis.html
- [ ] survey-responses.html

The zip file should NOT include:
- [ ] .env (contains API keys)
- [ ] serviceAccountKey.json (Firebase credentials)
- [ ] config.js (contains sensitive configuration)
- [ ] config.py (contains sensitive configuration)
- [ ] firebase-config.js (contains sensitive configuration)
- [ ] __pycache__/ (Python cache files)
- [ ] output/ (generated files)
- [ ] temp_wheels/ (temporary files)
- [ ] submissions.csv (user data)
- [ ] votes.json (user data)
- [ ] .git/ (version control)
- [ ] venv/ (virtual environment)
- [ ] Any other generated or temporary files

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgments

- ComfyUI for AI image generation capabilities
- Firebase for backend services
- Flask and SocketIO for real-time communication
- OpenAI for AI analysis features 