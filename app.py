from flask import Flask, render_template, request, jsonify, send_file, Response
import os
import base64
import sys
import logging
import json
import traceback
import time
import requests
import csv
from PIL import Image
import io
from flask_socketio import SocketIO, emit
from pyngrok import ngrok
import random
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

# Add these imports after installing firebase-admin
try:
    import firebase_admin
    from firebase_admin import credentials, storage, db
    import uuid
except ImportError as e:
    logging.error(f"Firebase import error: {e}")
    logging.error("Please run: pip install firebase-admin")
    sys.exit(1)

# Add OpenAI import
try:
    import openai
except ImportError as e:
    logging.error(f"OpenAI import error: {e}")
    logging.error("Please run: pip install openai")
    sys.exit(1)

from config import config

# Set up logging
logging.basicConfig(level=logging.DEBUG, 
                   format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Check for required packages
try:
    import requests
except ImportError:
    logger.error("'requests' package is not installed. Please run: pip install requests")
    sys.exit(1)

# Set up OpenAI client
try:
    openai.api_key = config['OPENAI_API_KEY']
    logging.info("OpenAI API key configured")
except Exception as e:
    logging.error(f"Error configuring OpenAI: {str(e)}")
    logging.error("OpenAI integration will not be available")

app = Flask(__name__,
           static_url_path='',
           static_folder='.',
           template_folder='.'
)

# Initialize SocketIO with proper configuration
socketio = SocketIO(app, 
                   cors_allowed_origins="*",
                   async_mode='threading',
                   logger=True,
                   engineio_logger=True,
                   ping_timeout=60,
                   ping_interval=25)

# Store connected users and their colors
connected_users = {}

# Add a counter for total users
total_users = 0

# ComfyUI settings
COMFYUI_API_URL = "http://127.0.0.1:8188"  # Base URL
COMFYUI_MODELS_PATH = r"C:\Users\fauxi\OneDrive\Documents\ComfyUI\ComfyUI_windows_portable\ComfyUI\models"
COMFYUI_OUTPUT_PATH = r"C:\Users\fauxi\OneDrive\Documents\ComfyUI\ComfyUI_windows_portable\ComfyUI\output"

# Add debug logging for ComfyUI paths
logging.info(f"ComfyUI API URL: {COMFYUI_API_URL}")
logging.info(f"ComfyUI Models Path: {COMFYUI_MODELS_PATH}")
logging.info(f"ComfyUI Output Path: {COMFYUI_OUTPUT_PATH}")
logging.info(f"Models directory exists: {os.path.exists(COMFYUI_MODELS_PATH)}")
logging.info(f"Output directory exists: {os.path.exists(COMFYUI_OUTPUT_PATH)}")

if os.path.exists(COMFYUI_MODELS_PATH):
    checkpoint_dir = os.path.join(COMFYUI_MODELS_PATH, "checkpoints")
    logging.info(f"Checkpoints directory exists: {os.path.exists(checkpoint_dir)}")
    if os.path.exists(checkpoint_dir):
        available_models = [f for f in os.listdir(checkpoint_dir) if f.endswith('.safetensors')]
        logging.info(f"Available checkpoint models: {available_models}")

# Update where we use the API key
headers = {
    "Authorization": f"Bearer {config['HUGGING_FACE_API_KEY']}"
}

# Initialize Firebase at the top of your app.py
cred = credentials.Certificate("serviceAccountKey.json")
try:
    # Use the correct project ID and storage bucket
    project_id = "conflicttoconcensus"
    storage_bucket = "conflicttoconcensus.firebasestorage.app"
    logging.info(f"Initializing Firebase with project ID: {project_id}, storage bucket: {storage_bucket}")
    
    firebase_admin.initialize_app(cred, {
        'databaseURL': f'https://{project_id}-default-rtdb.firebaseio.com',
        'storageBucket': storage_bucket
    })
    db = firebase_admin.db.reference()
    bucket = storage.bucket()
    
    # Test bucket access
    try:
        bucket.exists()
        logging.info(f"Successfully accessed storage bucket: {bucket.name}")
    except Exception as bucket_error:
        logging.error(f"Error accessing storage bucket: {str(bucket_error)}")
        logging.error("Please verify your Firebase storage bucket is correctly configured")
        logging.error("You may need to create the storage bucket in the Firebase console")
except Exception as e:
    logging.error(f"Error initializing Firebase: {str(e)}")
    logging.error(traceback.format_exc())

# Add debug logging
logging.info("Firebase initialization completed")

# WebSocket event handlers
@socketio.on('connect')
def handle_connect():
    user_id = request.sid
    logger.info(f"New WebSocket connection from {request.remote_addr} with ID: {user_id}")
    
    # Assign a random color to the user
    colors = ['#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF']
    user_color = random.choice(colors)
    connected_users[user_id] = {
        'color': user_color,
        'brush_size': 5,
        'connected_at': time.strftime('%Y-%m-%d %H:%M:%S')
    }
    
    logger.info(f"Connected users: {connected_users}")
    
    # First broadcast the new user to all clients
    emit('user_connected', {
        'user_id': user_id, 
        'color': user_color,
        'brush_size': 5,
        'total_users': len(connected_users)
    }, broadcast=True)
    
    # Then send the current state to the newly connected user
    emit('users_list', {
        'users': [
            {
                'id': uid,
                'color': data['color'],
                'brush_size': data['brush_size'],
                'connected_at': data['connected_at']
            }
            for uid, data in connected_users.items()
        ],
        'total_users': len(connected_users)
    })

@socketio.on('disconnect')
def handle_disconnect():
    user_id = request.sid
    logger.info(f"WebSocket disconnection from {request.remote_addr} with ID: {user_id}")
    
    if user_id in connected_users:
        del connected_users[user_id]
        logger.info(f"Connected users after disconnect: {connected_users}")
        
        # Broadcast updated user list to all remaining clients
        emit('users_list', {
            'users': [
                {
                    'id': uid,
                    'color': data['color'],
                    'brush_size': data['brush_size'],
                    'connected_at': data['connected_at']
                }
                for uid, data in connected_users.items()
            ],
            'total_users': len(connected_users)
        }, broadcast=True)

@socketio.on('brush_stroke')
def handle_brush_stroke(data):
    user_id = request.sid
    if user_id in connected_users:
        # Add user information to the data
        data['user_id'] = user_id
        user_data = connected_users[user_id]
        data['color'] = user_data['color']
        
        # Add timestamp for debugging
        data['timestamp'] = int(time.time() * 1000)
        
        # Log the brush stroke (only occasionally to avoid excessive logging)
        if random.random() < 0.01:  # Log approximately 1% of strokes
            logger.debug(f"Broadcasting brush stroke from {user_id}: {data}")
        
        # Broadcast to all other clients (exclude the sender)
        emit('brush_stroke', data, broadcast=True, include_self=False)
    else:
        logger.warning(f"Brush stroke from unknown user: {user_id}")

@socketio.on('update_brush_size')
def handle_brush_size_update(data):
    user_id = request.sid
    if user_id in connected_users:
        connected_users[user_id]['brush_size'] = data['size']
        emit('brush_size_updated', {'user_id': user_id, 'size': data['size']}, broadcast=True)

@socketio.on('image_upload')
def handle_image_upload(data):
    try:
        user_id = request.sid
        logger.info(f"User {user_id} uploaded image. Data: {data}")
        
        if user_id in connected_users and 'imageUrl' in data:
            # Add timestamp if not present
            if 'timestamp' not in data:
                data['timestamp'] = int(time.time() * 1000)
                
            # Add user information to the data
            data['user_id'] = user_id
            data['user_color'] = connected_users[user_id]['color']
            
            logger.info(f"Broadcasting image URL to all clients except sender: {data['imageUrl'][:100]}...")
            
            # Broadcast to all clients except sender
            emit('image_uploaded', data, broadcast=True, include_self=False)
            
            logger.info(f"Image URL broadcast successful")
            return {'status': 'success'}
    except Exception as e:
        logger.error(f"Error in handle_image_upload: {str(e)}")
        logger.error(traceback.format_exc())
        return {'status': 'error', 'message': str(e)}

@socketio.on('image_generated')
def handle_image_generated(data):
    try:
        user_id = request.sid
        logger.info(f"User {user_id} generated image. Data: {data}")
        
        if user_id in connected_users and 'image_url' in data:
            # Add user information to the data
            data['user_id'] = user_id
            
            logger.info(f"Broadcasting generated image URL to all clients: {data['image_url'][:100]}...")
            
            # Broadcast to all clients including sender
            emit('image_generated', data, broadcast=True)
            
            logger.info(f"Generated image URL broadcast successful")
            return {'status': 'success'}
    except Exception as e:
        logger.error(f"Error in handle_image_generated: {str(e)}")
        logger.error(traceback.format_exc())
        return {'status': 'error', 'message': str(e)}

@socketio.on('request_current_state')
def handle_state_request():
    try:
        user_id = request.sid
        logger.info(f"User {user_id} requested current state")
        
        # Send current users list
        emit('users_list', {
            'users': [
                {
                    'id': uid,
                    'color': data['color'],
                    'brush_size': data['brush_size'],
                    'connected_at': data['connected_at']
                }
                for uid, data in connected_users.items()
            ],
            'total_users': len(connected_users)
        })
        
        logger.info(f"Current state sent to user {user_id}")
    except Exception as e:
        logger.error(f"Error in handle_state_request: {str(e)}")
        logger.error(traceback.format_exc())

@socketio.on('location_updated')
def handle_location_updated(data):
    try:
        user_id = request.sid
        logger.info(f"User {user_id} updated location with panorama data: {data}")
        
        if user_id in connected_users and 'location' in data:
            # Add user information to the data
            data['user_id'] = user_id
            
            # Ensure we have all required data
            if 'panorama_id' not in data or 'heading' not in data:
                logger.warning(f"Missing panorama data in location update: {data}")
                return {'status': 'error', 'message': 'Missing panorama data'}
            
            # Log more detailed information about the broadcast
            logger.info(f"Broadcasting location update with panorama data from {user_id} to all other users")
            logger.info(f"Connected users: {list(connected_users.keys())}")
            logger.info(f"Broadcast data: {data}")
            
            # Broadcast to all other clients
            emit('location_updated', {
                'location': data['location'],
                'panorama_id': data['panorama_id'],
                'heading': data['heading'],
                'image_url': data.get('image_url'),
                'user_id': user_id
            }, broadcast=True, include_self=False)
            
            logger.info(f"Location update with panorama data broadcast successful")
            return {'status': 'success'}
        else:
            if user_id not in connected_users:
                logger.warning(f"User {user_id} not in connected_users list")
            if 'location' not in data:
                logger.warning(f"No location data provided: {data}")
            return {'status': 'error', 'message': 'Invalid user or data'}
    except Exception as e:
        logger.error(f"Error in handle_location_updated: {str(e)}")
        logger.error(traceback.format_exc())
        return {'status': 'error', 'message': str(e)}

@socketio.on('debug_ping')
def handle_debug_ping(data):
    try:
        user_id = request.sid
        logger.info(f"Received debug ping from {user_id}: {data}")
        
        # Add user ID to the data for identification
        data['user_id'] = user_id
        
        # Broadcast to all clients including sender
        logger.info(f"Broadcasting debug ping from {user_id} to all clients")
        emit('debug_ping', data, broadcast=True)
        
        logger.info(f"Debug ping broadcast completed")
        return {'status': 'success'}
    except Exception as e:
        logger.error(f"Error in handle_debug_ping: {str(e)}")
        logger.error(traceback.format_exc())
        return {'status': 'error', 'message': str(e)}

@socketio.on('start_drawing')
def handle_start_drawing():
    try:
        user_id = request.sid
        if user_id in connected_users:
            # Broadcast to all other clients that this user started drawing
            emit('user_drawing', {
                'user_id': user_id,
                'color': connected_users[user_id]['color'],
                'is_drawing': True
            }, broadcast=True, include_self=False)
    except Exception as e:
        logger.error(f"Error in handle_start_drawing: {str(e)}")
        logger.error(traceback.format_exc())

@socketio.on('stop_drawing')
def handle_stop_drawing():
    try:
        user_id = request.sid
        if user_id in connected_users:
            # Broadcast to all other clients that this user stopped drawing
            emit('user_drawing', {
                'user_id': user_id,
                'color': connected_users[user_id]['color'],
                'is_drawing': False
            }, broadcast=True, include_self=False)
    except Exception as e:
        logger.error(f"Error in handle_stop_drawing: {str(e)}")
        logger.error(traceback.format_exc())

@socketio.on('clear_mask')
def handle_clear_mask():
    try:
        user_id = request.sid
        if user_id in connected_users:
            # Broadcast to all other clients that this user cleared the mask
            emit('mask_cleared', {
                'user_id': user_id,
                'color': connected_users[user_id]['color']
            }, broadcast=True, include_self=False)
    except Exception as e:
        logger.error(f"Error in handle_clear_mask: {str(e)}")
        logger.error(traceback.format_exc())

@app.route('/')
def index():
    return render_template('index.html')

@app.route('/favicon.ico')
def favicon():
    return send_file('assets/images/logo.png', mimetype='image/png')

@app.route('/api/process', methods=['POST'])
def process():
    try:
        data = request.get_json()
        logging.debug(f"Received request with data keys: {list(data.keys())}")
        
        if not data:
            logging.error("No JSON data received")
            return jsonify({"error": "No data received"}), 400

        # Validate required fields
        required_fields = ['image', 'mask']
        for field in required_fields:
            if field not in data:
                logging.error(f"Missing required field: {field}")
                return jsonify({"error": f"Missing {field}"}), 400

        try:
            # Convert base64 strings to bytes
            image_bytes = base64.b64decode(data['image'])
            mask_bytes = base64.b64decode(data['mask'])
            
            # Process the workflow with binary data
            result = process_workflow(
                image_bytes,
                mask_bytes,
                data.get('prompt', ''),
                data.get('negative_prompt', '')
            )
            
            # Convert result image back to base64 for response
            if isinstance(result.get('image'), bytes):
                result['image'] = base64.b64encode(result['image']).decode('utf-8')
            
            return jsonify(result)
            
        except Exception as e:
            logging.error(f"Error processing data: {str(e)}")
            logging.error(traceback.format_exc())
            return jsonify({"error": str(e)}), 500

    except Exception as e:
        logging.error(f"Unexpected error: {str(e)}")
        logging.error(traceback.format_exc())
        return jsonify({"error": str(e)}), 500

@app.route('/test_comfyui')
def test_comfyui():
    try:
        # Test connection to ComfyUI
        response = requests.get(f"{COMFYUI_API_URL}/object_info")
        if response.status_code == 200:
            return jsonify({
                "status": "success",
                "message": "ComfyUI is running and accessible",
                "data": response.json()
            })
        else:
            return jsonify({
                "status": "error",
                "message": f"ComfyUI returned status code: {response.status_code}",
                "error": response.text
            }), 500
    except Exception as e:
        return jsonify({
            "status": "error",
            "message": "Failed to connect to ComfyUI",
            "error": str(e)
        }), 500

@app.route('/check_workflow')
def check_workflow():
    try:
        workflow_path = os.path.join(os.path.dirname(__file__), "Inpaint_Anything.json")
        if not os.path.exists(workflow_path):
            return jsonify({"error": "Workflow file not found"}), 404
            
        with open(workflow_path, 'r') as f:
            workflow_data = json.load(f)
            
        # Get node information
        nodes_info = [
            {
                "id": node.get("id"),
                "type": node.get("type"),
                "title": node.get("title", "")
            }
            for node in workflow_data.get("nodes", [])
        ]
            
        return jsonify({
            "status": "success",
            "nodes": nodes_info
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/test_workflow_conversion')
def test_workflow_conversion():
    try:
        workflow_path = os.path.join(os.path.dirname(__file__), "Inpaint_Anything.json")
        with open(workflow_path, 'r') as f:
            workflow_data = json.load(f)
            
        # Test converting first few nodes
        test_prompt = {}
        for node in workflow_data['nodes'][:5]:  # Test first 5 nodes
            node_id = str(node['id'])
            test_prompt[node_id] = {
                "class_type": node['type'],
                "inputs": node.get('inputs', {})
            }
            
        return jsonify({
            "status": "success",
            "test_prompt": test_prompt
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/debug_prompt')
def debug_prompt():
    try:
        workflow_path = os.path.join(os.path.dirname(__file__), "Inpaint_Anything.json")
        with open(workflow_path, 'r') as f:
            workflow_data = json.load(f)
            
        # Get a sample of the workflow structure
        sample = {
            "nodes": workflow_data['nodes'][:5],  # First 5 nodes
            "links": [link for link in workflow_data['links'] if link[1] < 5 and link[3] < 5]  # Related links
        }
            
        return jsonify({
            "status": "success",
            "sample": sample
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/test', methods=['POST'])
def test_endpoint():
    try:
        logger.debug(f"Test endpoint - Request Content-Type: {request.content_type}")
        logger.debug(f"Test endpoint - Request headers: {dict(request.headers)}")
        return jsonify({"status": "success"})
    except Exception as e:
        logger.error(f"Test endpoint error: {str(e)}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/history/<prompt_id>')
def get_history(prompt_id):
    try:
        response = requests.get(f"{COMFYUI_API_URL}/history")
        if response.status_code != 200:
            return jsonify({"error": "Failed to get history from ComfyUI"}), 500
            
        history = response.json()
        prompt_data = history.get(prompt_id)
        
        if not prompt_data:
            return jsonify({
                "completed": False,
                "progress": 0,
                "executing": False
            })
            
        # Check for execution errors
        status = prompt_data.get('status', {})
        status_str = status.get('status_str')
        messages = status.get('messages', [])
        
        # Log status for debugging
        logging.debug(f"Workflow status: {status_str}")
        logging.debug(f"Messages: {messages}")
        
        if status_str == 'error':
            error_messages = []
            for msg in messages:
                if msg[0] == 'execution_error':
                    error_data = msg[1]
                    error_messages.append({
                        'node_id': error_data.get('node_id'),
                        'node_type': error_data.get('node_type'),
                        'error_type': error_data.get('exception_type'),
                        'message': error_data.get('exception_message'),
                        'traceback': error_data.get('traceback', [])
                    })
            
            if error_messages:
                return jsonify({
                    "error": "Workflow execution failed",
                    "details": error_messages,
                    "status": status_str
                }), 500
            
        # Check if workflow completed
        if prompt_data.get('outputs'):
            images = []
            for node_id, output in prompt_data['outputs'].items():
                if output.get('images'):
                    images.extend(output['images'])
                    logging.info(f"Found {len(output['images'])} images in node {node_id}")
                    
            if images:
                logging.info(f"Workflow completed with {len(images)} total images")
                return jsonify({
                    "completed": True,
                    "images": images
                })
            else:
                logging.warning("Workflow completed but no images found")
                
        # Check execution status
        executing = False
        for msg in messages:
            if msg[0] == 'execution_start':
                executing = True
                logging.debug("Workflow execution started")
            elif msg[0] == 'execution_cached':
                executing = False
                logging.debug("Workflow execution cached")
            elif msg[0] == 'execution_error':
                executing = False
                logging.error("Workflow execution error")
                
        # Return progress
        progress = 0
        if prompt_data.get('progress'):
            progress = round(prompt_data['progress'].get('value', 0) * 100)
            logging.debug(f"Current progress: {progress}%")
            
        return jsonify({
            "completed": False,
            "progress": progress,
            "executing": executing,
            "status": status_str
        })

    except Exception as e:
        logging.error(f"Error getting history: {str(e)}")
        logging.error(traceback.format_exc())
        return jsonify({"error": str(e)}), 500

@app.route('/debug_workflow')
def debug_workflow():
    workflow_path = os.path.join(os.path.dirname(__file__), "Inpaint_Anything.json")
    with open(workflow_path, 'r') as f:
        workflow_data = json.load(f)
        
    # Find node 48 (Mask Crop Region)
    node_48 = next((node for node in workflow_data['nodes'] if str(node['id']) == '48'), None)
    if node_48:
        logging.debug("Node 48 configuration from JSON:")
        logging.debug(json.dumps(node_48, indent=2))

@app.route('/debug_node/<node_id>')
def debug_node_config(node_id):
    try:
        workflow_path = os.path.join(os.path.dirname(__file__), "Inpaint_Anything.json")
        with open(workflow_path, 'r') as f:
            workflow_data = json.load(f)
            
        # Find the node
        node = next((n for n in workflow_data['nodes'] if str(n['id']) == node_id), None)
        if not node:
            return jsonify({"error": f"Node {node_id} not found"}), 404
            
        # Get all links connected to this node
        links = [l for l in workflow_data['links'] if str(l[1]) == node_id or str(l[3]) == node_id]
            
        return jsonify({
            "node": node,
            "links": links
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/available_models', methods=['GET'])
def get_available_models():
    try:
        response = requests.get(f"{COMFYUI_API_URL}/object_info")
        if response.ok:
            data = response.json()
            models = {
                "checkpoints": data.get("CheckpointLoaderSimple", {}).get("input", {}).get("required", {}).get("ckpt_name", []),
                "vae": data.get("VAELoader", {}).get("input", {}).get("required", {}).get("vae_name", []),
                "clip": data.get("CLIPLoader", {}).get("input", {}).get("required", {}).get("clip_name", [])
            }
            return jsonify(models)
        else:
            return jsonify({"error": "Failed to get model info"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/debug/comfyui_paths')
def debug_comfyui_paths():
    base_dir = os.path.dirname(__file__)
    potential_paths = [
        os.path.join(os.path.dirname(base_dir), "ComfyUI"),
        os.path.join(base_dir, "ComfyUI"),
        os.path.join("C:", "ComfyUI"),
        os.path.join(os.path.expanduser("~"), "ComfyUI")
    ]
    
    results = {}
    for path in potential_paths:
        results[path] = {
            "exists": os.path.exists(path),
            "is_dir": os.path.isdir(path) if os.path.exists(path) else False,
            "output_dir_exists": os.path.exists(os.path.join(path, "output")) if os.path.exists(path) else False
        }
    
    return jsonify(results)

@app.route('/api/save-submission', methods=['POST'])
def save_submission():
    try:
        data = request.get_json()
        if not data or 'csvData' not in data:
            return jsonify({"error": "No data provided"}), 400

        csv_file_path = os.path.join(os.path.dirname(__file__), 'submissions.csv')
        
        # Check if file exists to write headers
        file_exists = os.path.exists(csv_file_path)
        
        with open(csv_file_path, 'a', newline='') as f:
            # Write headers if file is new
            if not file_exists:
                headers = ['Timestamp', 'Latitude', 'Longitude', 'Image URL', 
                          'Main Subject', 'Context', 'Avoid', 'Sunlight', 
                          'Movement', 'Privacy', 'Harmony']
                f.write(','.join(headers) + '\n')
            
            # Write the data
            f.write(data['csvData'])
        
        return jsonify({"success": True})
    
    except Exception as e:
        logging.error(f"Error saving to CSV: {str(e)}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/download-csv')
def download_csv():
    try:
        csv_file_path = os.path.join(os.path.dirname(__file__), 'submissions.csv')
        if not os.path.exists(csv_file_path):
            return jsonify({"error": "No submissions found"}), 404
            
        return send_file(
            csv_file_path,
            mimetype='text/csv',
            as_attachment=True,
            download_name='submissions.csv'
        )
    
    except Exception as e:
        logging.error(f"Error downloading CSV: {str(e)}")
        return jsonify({"error": str(e)}), 500

def load_submissions_from_csv():
    try:
        csv_file_path = os.path.join(os.path.dirname(__file__), 'submissions.csv')
        if not os.path.exists(csv_file_path):
            return []
            
        submissions = []
        with open(csv_file_path, 'r') as f:
            reader = csv.DictReader(f)
            for row in reader:
                submissions.append({
                    'timestamp': row['Timestamp'],
                    'location': {
                        'lat': float(row['Latitude']),
                        'lng': float(row['Longitude'])
                    },
                    'imageUrl': row['Image URL'],
                    'prompts': {
                        'mainSubject': row['Main Subject'],
                        'context': row['Context'],
                        'avoid': row['Avoid'],
                        'sliderValues': {
                            'sunlight': row['Sunlight'],
                            'movement': row['Movement'],
                            'privacy': row['Privacy'],
                            'harmony': row['Harmony']
                        }
                    }
                })
        return submissions
    
    except Exception as e:
        logging.error(f"Error loading submissions from CSV: {str(e)}")
        return []

@app.route('/api/submissions')
def get_submissions():
    try:
        submissions = load_submissions_from_csv()
        return jsonify(submissions)
    except Exception as e:
        logging.error(f"Error getting submissions: {str(e)}")
        return jsonify({"error": str(e)}), 500

def analyze_submissions_with_ai(submissions):
    """
    Use OpenAI to analyze submission data and provide insights
    """
    try:
        if not openai.api_key or openai.api_key == "your_openai_api_key_here":
            logging.warning("OpenAI API key not properly configured. Skipping AI analysis.")
            return "AI analysis unavailable: API key not configured"
            
        # Extract relevant data for analysis
        prompts_data = []
        for submission in submissions:
            prompts = submission.get('prompts', {})
            if prompts:
                prompt_text = {
                    "main_subject": prompts.get('mainSubject', ''),
                    "context": prompts.get('context', ''),
                    "avoid": prompts.get('avoid', ''),
                    "slider_values": prompts.get('sliderValues', {})
                }
                prompts_data.append(prompt_text)
        
        # Prepare prompt for OpenAI
        if not prompts_data:
            return "No prompt data available for analysis"
            
        system_prompt = """
        You are an expert at analyzing urban design and architectural preferences. 
        Analyze the submission data from an urban visualization tool and provide insightful observations.
        Focus on identifying patterns, common themes, contradictions, and unique insights.
        Structure your analysis in clear sections with bullet points where appropriate.
        Keep your response under 500 words and focus on actionable insights.
        """
        
        user_prompt = f"""
        Here is submission data from {len(submissions)} architectural/urban design submissions.
        Each submission contains prompts (main subject, context, elements to avoid) and slider values 
        for parameters like natural light, social/privacy balance, space flexibility, and comfort/atmosphere.
        
        Submission data:
        {json.dumps(prompts_data, indent=2)}
        
        Please analyze this data and provide insights about:
        1. Common themes and patterns in what people want in their spaces
        2. Contradictions or interesting tension points in the submissions
        3. Key insights about preferences for natural light, privacy, flexibility and comfort
        4. Any other notable observations
        5. Brief recommendations for urban planners based on these submissions
        """
        
        # Call OpenAI API using the new format
        client = openai.OpenAI()
        response = client.chat.completions.create(
            model="gpt-3.5-turbo",  # or another appropriate model
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            max_tokens=800,
            temperature=0.7
        )
        
        # Extract and return the analysis
        if response and hasattr(response, 'choices') and len(response.choices) > 0:
            analysis = response.choices[0].message.content
            logging.info("Successfully generated AI analysis of submissions")
            return analysis
        else:
            logging.error("Failed to get meaningful response from OpenAI")
            return "AI analysis failed: No meaningful response from OpenAI"
            
    except Exception as e:
        logging.error(f"Error performing AI analysis: {str(e)}")
        logging.error(traceback.format_exc())
        return f"AI analysis unavailable: {str(e)}"

@app.route('/api/generate-report')
def generate_report():
    try:
        logging.info("Generating submissions report")
        
        # Import required libraries
        try:
            import io
            logging.info("Successfully imported io")
            
            from reportlab.lib.pagesizes import letter
            logging.info("Successfully imported reportlab.lib.pagesizes")
            
            from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Image, Table, TableStyle
            logging.info("Successfully imported reportlab.platypus")
            
            from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
            logging.info("Successfully imported reportlab.lib.styles")
            
            from reportlab.lib import colors
            logging.info("Successfully imported reportlab.lib.colors")
            
            from collections import Counter
            logging.info("Successfully imported collections.Counter")
            
            try:
                import requests
                logging.info("Successfully imported requests")
            except ImportError:
                logging.error("Failed to import requests. PDF will have limited network functionality.")
                requests = None
            
            try:
                from PIL import Image as PILImage
                logging.info("Successfully imported PIL.Image")
            except ImportError:
                logging.error("Failed to import PIL.Image. PDF will have limited image support.")
                PILImage = None
            
            try:
                from wordcloud import WordCloud
                logging.info("Successfully imported wordcloud.WordCloud")
            except ImportError:
                logging.error("Failed to import wordcloud. PDF will not include word clouds.")
                WordCloud = None
                
            try:
                import matplotlib.pyplot as plt
                import numpy as np
                logging.info("Successfully imported matplotlib and numpy")
                
                # Use Agg backend (non-interactive, does not require a display)
                import matplotlib
                matplotlib.use('Agg')
                logging.info("Set matplotlib backend to Agg")
            except ImportError as e:
                logging.error(f"Failed to import matplotlib/numpy: {str(e)}. PDF will not include charts.")
                plt = None
                np = None
                
        except ImportError as e:
            logging.error(f"Missing required library for PDF generation: {str(e)}")
            return jsonify({
                "error": f"Missing required library for PDF generation: {str(e)}. Install with: pip install reportlab pillow matplotlib wordcloud"
            }), 500
        
        # Get all submissions
        submissions = load_submissions_from_csv()
        
        # If no submissions, create sample data for testing
        if not submissions:
            logging.warning("No submissions found. Creating sample data for report.")
            # Create some dummy submissions with realistic data (similar to analyze-submissions endpoint)
            submissions = [
                {
                    "id": "sample1",
                    "username": "user1",
                    "timestamp": time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(time.time() - 86400)),
                    "imageUrl": "sample_url_1",
                    "location": {"lat": 40.8075, "lng": -73.9626},
                    "prompts": {
                        "mainSubject": "Open work area with natural light",
                        "context": "Modern university design studio, collaborative environment",
                        "avoid": "Clutter, dark corners, institutional feel",
                        "sliderValues": {
                            "sunlight": 80,
                            "movement": 60,
                            "privacy": 75,
                            "harmony": 85
                        }
                    }
                },
                {
                    "id": "sample2",
                    "username": "user2",
                    "timestamp": time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(time.time() - 43200)),
                    "imageUrl": "sample_url_2",
                    "location": {"lat": 40.8080, "lng": -73.9630},
                    "prompts": {
                        "mainSubject": "Private study nooks with sound isolation",
                        "context": "Graduate student workspace with focus on individual work",
                        "avoid": "Sterile environment, noise, distraction",
                        "sliderValues": {
                            "sunlight": 65,
                            "movement": 85,
                            "privacy": 40,
                            "harmony": 70
                        }
                    }
                },
                {
                    "id": "sample3",
                    "username": "user3",
                    "timestamp": time.strftime('%Y-%m-%d %H:%M:%S'),
                    "imageUrl": "sample_url_3",
                    "location": {"lat": 40.8085, "lng": -73.9640},
                    "prompts": {
                        "mainSubject": "Flexible meeting spaces with movable furniture",
                        "context": "Multi-purpose area for critiques and presentations",
                        "avoid": "Fixed layouts, poor sight lines, uncomfortable seating",
                        "sliderValues": {
                            "sunlight": 70,
                            "movement": 40,
                            "privacy": 90,
                            "harmony": 75
                        }
                    }
                }
            ]
            logging.info(f"Created {len(submissions)} sample submissions for report")
        
        # Create an in-memory PDF
        buffer = io.BytesIO()
        
        # Create the PDF document
        doc = SimpleDocTemplate(buffer, pagesize=letter)
        styles = getSampleStyleSheet()
        
        # Create custom styles
        title_style = ParagraphStyle(
            'TitleStyle',
            parent=styles['Heading1'],
            fontSize=24,
            textColor=colors.blue,
            spaceAfter=12
        )
        
        heading_style = ParagraphStyle(
            'HeadingStyle',
            parent=styles['Heading2'],
            fontSize=18,
            textColor=colors.darkblue,
            spaceAfter=10,
            spaceBefore=20
        )
        
        subheading_style = ParagraphStyle(
            'SubheadingStyle',
            parent=styles['Heading3'],
            fontSize=14,
            textColor=colors.darkblue,
            spaceAfter=6,
            spaceBefore=10
        )
        
        normal_style = ParagraphStyle(
            'NormalStyle',
            parent=styles['Normal'],
            fontSize=10,
            spaceAfter=6
        )
        
        # Initialize the PDF content
        elements = []
        
        # Add title
        elements.append(Paragraph("Consensus Submissions Report", title_style))
        elements.append(Spacer(1, 12))
        
        # Add summary
        elements.append(Paragraph(f"Total Submissions: {len(submissions)}", heading_style))
        elements.append(Paragraph(f"Report Generated: {time.strftime('%Y-%m-%d %H:%M:%S')}", normal_style))
        elements.append(Spacer(1, 12))
        
        # Add AI Analysis Section
        elements.append(Paragraph("AI Analysis of Submissions", heading_style))
        
        # Generate AI analysis
        ai_analysis = analyze_submissions_with_ai(submissions)
        
        # Split the analysis into paragraphs and add to PDF
        if ai_analysis:
            for paragraph in ai_analysis.split('\n\n'):
                if paragraph.strip():
                    # Check if this is a section header (indicated by ending with ":")
                    if paragraph.strip().endswith(':'):
                        elements.append(Paragraph(paragraph, subheading_style))
                    # Check if this is a bullet point
                    elif paragraph.strip().startswith('•') or paragraph.strip().startswith('-'):
                        elements.append(Paragraph(paragraph, normal_style))
                    else:
                        elements.append(Paragraph(paragraph, normal_style))
            
            elements.append(Spacer(1, 20))
        
        # Analyze common themes from prompts
        elements.append(Paragraph("Common Themes Analysis", heading_style))
        
        # Collect all main subjects and context prompts
        all_main_subjects = []
        all_contexts = []
        all_avoid_terms = []
        
        # Collect slider values
        sunlight_values = []
        movement_values = []
        privacy_values = []
        harmony_values = []
        
        # Aggregate data from all submissions
        for submission in submissions:
            prompts = submission.get('prompts', {})
            
            # Main subject
            main_subject = prompts.get('mainSubject', '')
            if main_subject and main_subject != 'N/A':
                all_main_subjects.extend(main_subject.lower().split())
            
            # Context
            context = prompts.get('context', '')
            if context and context != 'N/A':
                all_contexts.extend(context.lower().split())
            
            # Avoid terms
            avoid = prompts.get('avoid', '')
            if avoid and avoid != 'N/A':
                all_avoid_terms.extend(avoid.lower().split())
            
            # Slider values
            slider_values = prompts.get('sliderValues', {})
            if slider_values:
                try:
                    sunlight_values.append(float(slider_values.get('sunlight', 0)))
                    movement_values.append(float(slider_values.get('movement', 0)))
                    privacy_values.append(float(slider_values.get('privacy', 0)))
                    harmony_values.append(float(slider_values.get('harmony', 0)))
                except (ValueError, TypeError):
                    pass
        
        # Filter out common stop words
        stop_words = {'the', 'and', 'to', 'a', 'in', 'of', 'with', 'is', 'that', 'for', 'on', 'at', 'this', 'an', 'by'}
        filtered_main_subjects = [word for word in all_main_subjects if word.lower() not in stop_words and len(word) > 2]
        filtered_contexts = [word for word in all_contexts if word.lower() not in stop_words and len(word) > 2]
        filtered_avoid_terms = [word for word in all_avoid_terms if word.lower() not in stop_words and len(word) > 2]
        
        # Get most common terms for each category
        main_subject_counter = Counter(filtered_main_subjects)
        context_counter = Counter(filtered_contexts)
        avoid_counter = Counter(filtered_avoid_terms)
        
        # Function to get top N items from counter
        def get_top_items(counter, n=10):
            return counter.most_common(n)
        
        # Add common themes data
        main_subject_terms = get_top_items(main_subject_counter, 5)
        context_terms = get_top_items(context_counter, 5)
        avoid_terms = get_top_items(avoid_counter, 5)
        
        # Create a table for common themes
        if main_subject_terms or context_terms or avoid_terms:
            elements.append(Paragraph("Most Common Terms in Prompts", subheading_style))
            theme_data = [["Category", "Term", "Frequency"]]
            
            for term, count in main_subject_terms:
                theme_data.append(["Main Subject", term, str(count)])
            
            for term, count in context_terms:
                theme_data.append(["Context", term, str(count)])
            
            for term, count in avoid_terms:
                theme_data.append(["Avoid", term, str(count)])
            
            theme_table = Table(theme_data, colWidths=[120, 200, 80])
            theme_table.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), colors.lightblue),
                ('TEXTCOLOR', (0, 0), (-1, 0), colors.black),
                ('ALIGN', (0, 0), (-1, 0), 'CENTER'),
                ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                ('FONTSIZE', (0, 0), (-1, 0), 12),
                ('BOTTOMPADDING', (0, 0), (-1, 0), 12),
                ('BACKGROUND', (0, 1), (-1, -1), colors.white),
                ('TEXTCOLOR', (0, 1), (-1, -1), colors.black),
                ('ALIGN', (0, 1), (-1, -1), 'LEFT'),
                ('FONTNAME', (0, 1), (-1, -1), 'Helvetica'),
                ('FONTSIZE', (0, 1), (-1, -1), 10),
                ('GRID', (0, 0), (-1, -1), 1, colors.black),
            ]))
            elements.append(theme_table)
            elements.append(Spacer(1, 12))
        
        # Generate word cloud if there are enough words and wordcloud is available
        try:
            if WordCloud is not None and len(filtered_main_subjects) > 10:
                elements.append(Paragraph("Word Cloud from All Prompts", subheading_style))
                
                # Combine all filtered words for the word cloud
                all_words = filtered_main_subjects + filtered_contexts
                all_words_text = ' '.join(all_words)
                
                # Generate word cloud
                wordcloud = WordCloud(width=600, height=300, background_color='white', 
                                    max_words=100, contour_width=1, contour_color='steelblue')
                wordcloud.generate(all_words_text)
                
                # Save word cloud to a temporary buffer
                wordcloud_img_buffer = io.BytesIO()
                plt.figure(figsize=(8, 4))
                plt.imshow(wordcloud, interpolation='bilinear')
                plt.axis("off")
                plt.tight_layout(pad=0)
                plt.savefig(wordcloud_img_buffer, format='png')
                plt.close()
                
                # Add word cloud image to PDF
                wordcloud_img_buffer.seek(0)
                wordcloud_img = Image(wordcloud_img_buffer, width=400, height=200)
                elements.append(wordcloud_img)
                elements.append(Spacer(1, 20))
        except Exception as wordcloud_error:
            logging.error(f"Error generating word cloud: {str(wordcloud_error)}")
            elements.append(Paragraph(f"Word cloud generation failed: {str(wordcloud_error)}", normal_style))
            elements.append(Spacer(1, 10))
        
        # Add slider value averages if there are values
        if sunlight_values or movement_values or privacy_values or harmony_values:
            try:
                elements.append(Paragraph("Modifier Preferences", subheading_style))
                
                avg_sunlight = sum(sunlight_values) / len(sunlight_values) if sunlight_values else 0
                avg_movement = sum(movement_values) / len(movement_values) if movement_values else 0
                avg_privacy = sum(privacy_values) / len(privacy_values) if privacy_values else 0
                avg_harmony = sum(harmony_values) / len(harmony_values) if harmony_values else 0
                
                slider_data = [
                    ["Modifier", "Average Value"],
                    ["Natural Light", f"{avg_sunlight:.1f}%"],
                    ["Social/Privacy Balance", f"{avg_movement:.1f}%"],
                    ["Space Flexibility", f"{avg_privacy:.1f}%"],
                    ["Comfort/Atmosphere", f"{avg_harmony:.1f}%"]
                ]
                
                slider_table = Table(slider_data, colWidths=[200, 100])
                slider_table.setStyle(TableStyle([
                    ('BACKGROUND', (0, 0), (-1, 0), colors.lightblue),
                    ('TEXTCOLOR', (0, 0), (-1, 0), colors.black),
                    ('ALIGN', (0, 0), (-1, 0), 'CENTER'),
                    ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                    ('FONTSIZE', (0, 0), (-1, 0), 12),
                    ('BOTTOMPADDING', (0, 0), (-1, 0), 12),
                    ('BACKGROUND', (0, 1), (-1, -1), colors.white),
                    ('TEXTCOLOR', (0, 1), (-1, -1), colors.black),
                    ('ALIGN', (0, 1), (0, -1), 'LEFT'),
                    ('ALIGN', (1, 1), (1, -1), 'CENTER'),
                    ('FONTNAME', (0, 1), (-1, -1), 'Helvetica'),
                    ('FONTSIZE', (0, 1), (-1, -1), 10),
                    ('GRID', (0, 0), (-1, -1), 1, colors.black),
                ]))
                elements.append(slider_table)
                elements.append(Spacer(1, 20))
                
                # Create bar chart for slider values if matplotlib is available
                if plt is not None and np is not None:
                    elements.append(Paragraph("Modifier Preferences Visualization", subheading_style))
                    
                    # Generate bar chart
                    modifier_labels = ['Natural Light', 'Social/Privacy', 'Space Flexibility', 'Comfort/Atmosphere']
                    avg_values = [avg_sunlight, avg_movement, avg_privacy, avg_harmony]
                    
                    plt.figure(figsize=(8, 4))
                    bars = plt.bar(modifier_labels, avg_values, color=['#FFD700', '#4CAF50', '#2196F3', '#9C27B0'])
                    plt.ylim(0, 100)
                    plt.ylabel('Average Value (%)')
                    plt.title('Average Modifier Preferences')
                    
                    # Add value labels on top of bars
                    for bar in bars:
                        height = bar.get_height()
                        plt.text(bar.get_x() + bar.get_width()/2., height + 2,
                                f'{height:.1f}%', ha='center', va='bottom', fontsize=9)
                    
                    chart_buffer = io.BytesIO()
                    plt.savefig(chart_buffer, format='png', bbox_inches='tight', dpi=100)
                    plt.close()
                    
                    chart_buffer.seek(0)
                    chart_img = Image(chart_buffer, width=400, height=200)
                    elements.append(chart_img)
                    elements.append(Spacer(1, 20))
            except Exception as slider_error:
                logging.error(f"Error generating modifier preferences section: {str(slider_error)}")
                elements.append(Paragraph(f"Modifier preferences visualization failed: {str(slider_error)}", normal_style))
                elements.append(Spacer(1, 10))
        
        # Add top submissions by votes
        elements.append(Paragraph("Top Submissions by Votes", heading_style))
        
        # Try to get vote data, but handle errors gracefully
        try:
            # Get vote data from Firebase or local file
            if requests is not None:
                vote_data_response = requests.get(f"{request.url_root}api/vote-data")
                if vote_data_response.ok:
                    vote_data = vote_data_response.json()
                    
                    # If we have vote data, sort submissions by votes
                    if vote_data and 'votes' in vote_data:
                        # Create a list of submissions with their vote counts
                        submissions_with_votes = []
                        for submission in submissions:
                            submission_id = submission.get('submittedAt', None) or submission.get('timestamp', None)
                            if submission_id:
                                votes_info = vote_data['votes'].get(str(submission_id), {'upvotes': 0, 'downvotes': 0})
                                net_votes = votes_info.get('upvotes', 0) - votes_info.get('downvotes', 0)
                                submissions_with_votes.append({
                                    'submission': submission,
                                    'net_votes': net_votes,
                                    'upvotes': votes_info.get('upvotes', 0),
                                    'downvotes': votes_info.get('downvotes', 0)
                                })
                        
                        # Sort by net votes (descending)
                        submissions_with_votes.sort(key=lambda x: x['net_votes'], reverse=True)
                        
                        # Take top 5 submissions
                        top_submissions = submissions_with_votes[:5]
                        
                        if top_submissions:
                            top_submissions_data = [["Rank", "Location", "Main Subject", "Votes"]]
                            
                            for i, item in enumerate(top_submissions):
                                submission = item['submission']
                                location = submission.get('location', {})
                                lat = location.get('lat', 'N/A')
                                lng = location.get('lng', 'N/A')
                                location_str = f"({lat:.4f}, {lng:.4f})"
                                main_subject = submission.get('prompts', {}).get('mainSubject', 'N/A')
                                vote_count = f"{item['net_votes']} (+{item['upvotes']}/-{item['downvotes']})"
                                
                                top_submissions_data.append([str(i+1), location_str, main_subject, vote_count])
                            
                            top_table = Table(top_submissions_data, colWidths=[50, 120, 220, 100])
                            top_table.setStyle(TableStyle([
                                ('BACKGROUND', (0, 0), (-1, 0), colors.lightblue),
                                ('TEXTCOLOR', (0, 0), (-1, 0), colors.black),
                                ('ALIGN', (0, 0), (-1, 0), 'CENTER'),
                                ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                                ('FONTSIZE', (0, 0), (-1, 0), 12),
                                ('BOTTOMPADDING', (0, 0), (-1, 0), 12),
                                ('BACKGROUND', (0, 1), (-1, -1), colors.white),
                                ('TEXTCOLOR', (0, 1), (-1, -1), colors.black),
                                ('ALIGN', (0, 1), (0, -1), 'CENTER'),
                                ('ALIGN', (3, 1), (3, -1), 'CENTER'),
                                ('FONTNAME', (0, 1), (-1, -1), 'Helvetica'),
                                ('FONTSIZE', (0, 1), (-1, -1), 10),
                                ('GRID', (0, 0), (-1, -1), 1, colors.black),
                            ]))
                            elements.append(top_table)
                            elements.append(Spacer(1, 12))
                            
                            # Include images of top 3 submissions if available
                            if len(top_submissions) >= 3 and PILImage is not None:
                                elements.append(Paragraph("Top 3 Submissions", subheading_style))
                                elements.append(Spacer(1, 12))
                                
                                for i, item in enumerate(top_submissions[:3]):
                                    submission = item['submission']
                                    image_url = submission.get('imageUrl')
                                    
                                    if image_url and i < 3 and 'sample' not in image_url:  # Only include top 3 real images
                                        try:
                                            # Download the image
                                            if requests is not None:
                                                img_response = requests.get(image_url)
                                                if img_response.ok:
                                                    img_data = img_response.content
                                                    img_buffer = io.BytesIO(img_data)
                                                    
                                                    # Get the image dimensions
                                                    pil_img = PILImage.open(img_buffer)
                                                    img_width, img_height = pil_img.size
                                                    
                                                    # Calculate aspect ratio
                                                    aspect_ratio = img_width / img_height
                                                    
                                                    # Add image to PDF (max width 400)
                                                    pdf_img_width = 400
                                                    pdf_img_height = int(pdf_img_width / aspect_ratio)
                                                    
                                                    # Reset buffer position
                                                    img_buffer.seek(0)
                                                    
                                                    # Create image for PDF
                                                    pdf_img = Image(img_buffer, width=pdf_img_width, height=pdf_img_height)
                                                    
                                                    # Add rank label
                                                    rank_text = f"Rank {i+1} - {item['net_votes']} votes"
                                                    elements.append(Paragraph(rank_text, subheading_style))
                                                    elements.append(pdf_img)
                                                    elements.append(Spacer(1, 20))
                                        except Exception as img_error:
                                            logging.error(f"Error processing image for PDF: {str(img_error)}")
                                            elements.append(Paragraph(f"Error loading image: {str(img_error)}", normal_style))
                            else:
                                elements.append(Paragraph("No real images available for top submissions", normal_style))
                        else:
                            elements.append(Paragraph("No voted submissions available", normal_style))
                    else:
                        elements.append(Paragraph("No vote data available", normal_style))
                else:
                    elements.append(Paragraph("Vote data not available from server", normal_style))
            else:
                elements.append(Paragraph("Requests library not available - cannot fetch vote data", normal_style))
        except Exception as vote_error:
            logging.error(f"Error processing vote data for report: {str(vote_error)}")
            elements.append(Paragraph(f"Unable to access vote data: {str(vote_error)}", normal_style))
        
        # Generate the PDF
        doc.build(elements)
        
        # Get the PDF value
        pdf_value = buffer.getvalue()
        buffer.close()
        
        # Return the PDF
        return send_file(
            io.BytesIO(pdf_value),
            mimetype='application/pdf',
            as_attachment=True,
            download_name='consensus_submissions_report.pdf',
            etag=False,
            last_modified=None,
            max_age=None
        )
        
    except Exception as e:
        logging.error(f"Error generating report: {str(e)}")
        logging.error(traceback.format_exc())
        return jsonify({"error": str(e)}), 500

@app.route('/api/vote-data')
def get_vote_data():
    """Endpoint to provide vote data for the report generation."""
    try:
        # Get votes from Firebase Realtime Database
        votes_ref = db.reference('votes')
        votes_data = votes_ref.get()
        if votes_data is None:
            votes_data = {"votes": {}}
        
        return jsonify(votes_data)
    except Exception as e:
        logging.error(f"Error getting vote data from Firebase: {str(e)}")
        logging.error(traceback.format_exc())
        
        # Fallback to local file if Firebase fails
        try:
            votes_file_path = os.path.join(os.path.dirname(__file__), 'votes.json')
            if os.path.exists(votes_file_path):
                with open(votes_file_path, 'r') as f:
                    votes_data = json.load(f)
            else:
                votes_data = {"votes": {}}
            
            return jsonify(votes_data)
        except Exception as fallback_error:
            logging.error(f"Error getting vote data from fallback file: {str(fallback_error)}")
            return jsonify({"votes": {}}), 500

@app.route('/api/save-votes', methods=['POST'])
def save_votes():
    """Save votes from the client to Firebase."""
    try:
        data = request.get_json()
        if not data or 'votes' not in data:
            logging.error("No vote data provided in request")
            return jsonify({"error": "No vote data provided"}), 400
        
        logging.info(f"Received vote data: {data}")
        
        try:
            # Save to Firebase Realtime Database
            votes_ref = db.reference('votes')
            votes_ref.set(data['votes'])
            logging.info(f"Successfully saved {len(data['votes'])} votes to Firebase")
        except Exception as firebase_error:
            logging.error(f"Firebase error: {str(firebase_error)}")
            logging.error(traceback.format_exc())
            # Continue to save to local file even if Firebase fails
        
        # Save to local file as backup
        try:
            votes_file_path = os.path.join(os.path.dirname(__file__), 'votes.json')
            os.makedirs(os.path.dirname(votes_file_path), exist_ok=True)
            with open(votes_file_path, 'w') as f:
                json.dump(data, f, indent=2)
            logging.info(f"Successfully saved votes to local file: {votes_file_path}")
        except Exception as file_error:
            logging.error(f"Error saving votes to backup file: {str(file_error)}")
            logging.error(traceback.format_exc())
            
        return jsonify({"success": True, "message": "Votes saved successfully"})
        
    except Exception as e:
        logging.error(f"Error in save_votes endpoint: {str(e)}")
        logging.error(traceback.format_exc())
        return jsonify({"error": f"Failed to save votes: {str(e)}"}), 500

def resize_image_if_needed(image_data, max_size=1024):
    """Resize image if it exceeds max_size while maintaining aspect ratio"""
    try:
        # Convert bytes to PIL Image
        image = Image.open(io.BytesIO(image_data))
        
        # Get current dimensions
        width, height = image.size
        
        # Calculate scaling factor if image is too large
        if width > max_size or height > max_size:
            scale = max_size / max(width, height)
            new_width = int(width * scale)
            new_height = int(height * scale)
            
            # Resize image
            image = image.resize((new_width, new_height), Image.Resampling.LANCZOS)
            
            # Convert back to bytes
            output = io.BytesIO()
            image.save(output, format='PNG')
            return output.getvalue()
            
        return image_data
    except Exception as e:
        logging.error(f"Error resizing image: {str(e)}")
        return image_data

def process_workflow(image_data, mask_data, prompt='', negative_prompt=''):
    try:
        # Resize images if needed
        image_data = resize_image_if_needed(image_data)
        mask_data = resize_image_if_needed(mask_data)
        
        # Create unique temporary filenames using timestamp
        timestamp = str(int(time.time() * 1000))
        base_dir = os.path.dirname(__file__)
        temp_image_path = os.path.join(base_dir, f"temp_image_{timestamp}.png")
        temp_mask_path = os.path.join(base_dir, f"temp_mask_{timestamp}.png")
        output_path = os.path.join(COMFYUI_OUTPUT_PATH, f"output_{timestamp}.png")
        
        temp_files = [temp_image_path, temp_mask_path]

        try:
            # Save the binary data to temporary files
            with open(temp_image_path, 'wb') as f:
                f.write(image_data)
            with open(temp_mask_path, 'wb') as f:
                f.write(mask_data)

            # First, get available models
            try:
                response = requests.get(f"{COMFYUI_API_URL}/object_info")
                if response.status_code != 200:
                    raise Exception(f"Failed to get available models: {response.text}")
                
                available_models = response.json()
                logging.info(f"Available models from API: {available_models}")
                
                # Get the first available checkpoint model
                checkpoint_info = available_models.get("CheckpointLoaderSimple", {})
                available_checkpoints = checkpoint_info.get("input", {}).get("required", {}).get("ckpt_name", [])
                
                if not available_checkpoints:
                    # If no checkpoints found in API, try to get them from the filesystem
                    checkpoint_dir = os.path.join(COMFYUI_MODELS_PATH, "checkpoints")
                    if os.path.exists(checkpoint_dir):
                        available_checkpoints = [f for f in os.listdir(checkpoint_dir) if f.endswith('.safetensors')]
                        logging.info(f"Found checkpoints in filesystem: {available_checkpoints}")
                    else:
                        raise Exception("No checkpoint models found in ComfyUI")
                
                # Use a specific model name that's commonly available
                checkpoint_name = "juggernautXL_juggXIByRundiffusion.safetensors"
                logging.info(f"Using checkpoint model: {checkpoint_name}")
            except Exception as e:
                logging.error(f"Error getting models: {str(e)}")
                # Fallback to a default model if available
                checkpoint_name = "juggernautXL_juggXIByRundiffusion.safetensors"
                logging.info(f"Using fallback checkpoint model: {checkpoint_name}")
            
            # Define the workflow with the available model
            workflow = {
                "225": {
                    "class_type": "CheckpointLoaderSimple",
                    "inputs": {
                        "ckpt_name": "juggernautXL_juggXIByRundiffusion.safetensors"
                    }
                },
                "241": {
                    "class_type": "CLIPTextEncode",
                    "inputs": {
                        "text": prompt if prompt else "a high quality image",
                        "clip": ["225", 1]
                    }
                },
                "19": {
                    "class_type": "CLIPTextEncode",
                    "inputs": {
                        "text": negative_prompt if negative_prompt else "blur, text, watermark, CGI, Unreal, Airbrushed, Digital",
                        "clip": ["225", 1]
                    }
                },
                "1": {
                    "class_type": "LoadImage",
                    "inputs": {
                        "image": temp_image_path
                    }
                },
                "2": {
                    "class_type": "LoadImage",
                    "inputs": {
                        "image": temp_mask_path
                    }
                },
                "11": {
                    "class_type": "ImageToMask",
                    "inputs": {
                        "image": ["2", 0],
                        "channel": "red"
                    }
                },
                "8": {
                    "class_type": "VAEEncode",
                    "inputs": {
                        "pixels": ["1", 0],
                        "vae": ["225", 2]
                    }
                },
                "10": {
                    "class_type": "SetLatentNoiseMask",
                    "inputs": {
                        "samples": ["8", 0],
                        "mask": ["11", 0]
                    }
                },
                "248": {
                    "class_type": "KSampler",
                    "inputs": {
                        "model": ["225", 0],
                        "positive": ["241", 0],
                        "negative": ["19", 0],
                        "latent_image": ["10", 0],
                        "sampler_name": "dpmpp_2m",  # Changed from euler to dpmpp_2m for better quality
                        "scheduler": "karras",  # Changed from normal to karras for better quality
                        "seed": int(time.time()),
                        "steps": 30,  # Increased from 20 to 30 for better detail
                        "cfg": 8.5,  # Increased from 7 to 8.5 for better prompt adherence
                        "denoise": 0.85  # Reduced from 1 to 0.85 for better preservation of original image context
                    }
                },
                "249": {
                    "class_type": "VAEDecode",
                    "inputs": {
                        "samples": ["248", 0],
                        "vae": ["225", 2]
                    }
                },
                "9": {
                    "class_type": "SaveImage",
                    "inputs": {
                        "images": ["249", 0],
                        "filename_prefix": f"output_{timestamp}"
                    }
                }
            }

            # Send the workflow to ComfyUI
            logging.info("Sending workflow to ComfyUI")
            logging.debug(f"Workflow configuration: {json.dumps(workflow, indent=2)}")
            
            try:
                response = requests.post(f"{COMFYUI_API_URL}/prompt", json={"prompt": workflow})
                if response.status_code != 200:
                    error_msg = f"ComfyUI API error: {response.text}"
                    logging.error(error_msg)
                    raise Exception(error_msg)
                
                result = response.json()
                logging.info(f"ComfyUI response: {result}")
                
                # Wait for the image to be generated
                prompt_id = result.get('prompt_id')
                if not prompt_id:
                    raise Exception("No prompt ID received from ComfyUI")
                
                # Poll for the result
                max_attempts = 60
                attempt = 0
                while attempt < max_attempts:
                    history_response = requests.get(f"{COMFYUI_API_URL}/history/{prompt_id}")
                    if history_response.status_code == 200:
                        history = history_response.json()
                        if prompt_id in history:
                            outputs = history[prompt_id].get('outputs', {})
                            if '9' in outputs and outputs['9'].get('images'):
                                image_data = outputs['9']['images'][0]
                                # Update the image path to look in ComfyUI's output directory
                                comfyui_output_dir = os.path.join(COMFYUI_MODELS_PATH, "..", "output")
                                image_path = os.path.join(comfyui_output_dir, image_data['filename'])
                                
                                logging.info(f"Looking for generated image at: {image_path}")
                                
                                # Read the generated image
                                with open(image_path, 'rb') as f:
                                    image_bytes = f.read()
                                
                                # Upload to Firebase Storage
                                try:
                                    # Generate a unique filename
                                    firebase_filename = f"generated_images/{timestamp}_{image_data['filename']}"
                                    blob = bucket.blob(firebase_filename)
                                    
                                    # Upload the image
                                    blob.upload_from_string(
                                        image_bytes,
                                        content_type='image/png'
                                    )
                                    
                                    # Get the public URL
                                    blob.make_public()
                                    image_url = blob.public_url
                                    
                                    logging.info(f"Image uploaded to Firebase: {image_url}")
                                    
                                    # Clean up temporary files
                                    for file in temp_files:
                                        if os.path.exists(file):
                                            os.remove(file)
                                    
                                    return {
                                        'image_url': image_url,
                                        'success': True
                                    }
                                    
                                except Exception as e:
                                    logging.error(f"Error uploading to Firebase: {str(e)}")
                                    logging.warning("Falling back to direct image return via base64")
                                    
                                    # Return the image directly as base64
                                    # Clean up temporary files first
                                    for file in temp_files:
                                        if os.path.exists(file):
                                            os.remove(file)
                                    
                                    # Return the image as base64
                                    return {
                                        'image': image_bytes,
                                        'success': True,
                                        'firebase_error': str(e)
                                    }
                    
                    time.sleep(1)
                    attempt += 1
                    logging.info(f"Waiting for image generation... Attempt {attempt}/{max_attempts}")
                
                raise Exception("Timeout waiting for image generation")
                
            except requests.exceptions.RequestException as e:
                logging.error(f"Network error while communicating with ComfyUI: {str(e)}")
                raise Exception(f"Failed to communicate with ComfyUI: {str(e)}")
            
        finally:
            # Clean up temporary files
            for file in temp_files:
                if os.path.exists(file):
                    os.remove(file)
        
    except Exception as e:
        logging.error(f"Error in process_workflow: {str(e)}")
        logging.error(traceback.format_exc())
        raise

@app.route('/api/connected-users')
def get_connected_users():
    try:
        users_info = []
        for user_id, user_data in connected_users.items():
            users_info.append({
                'id': user_id,
                'color': user_data['color'],
                'brush_size': user_data['brush_size'],
                'connected_at': user_data['connected_at']
            })
        return jsonify({
            'total_users': len(connected_users),
            'users': users_info
        })
    except Exception as e:
        logger.error(f"Error getting connected users: {str(e)}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/analyze-submissions')
def api_analyze_submissions():
    """API endpoint to get AI analysis of submissions"""
    try:
        # Get all submissions
        submissions = load_submissions_from_csv()
        
        # If no submissions, create sample data for testing
        if not submissions:
            logging.warning("No submissions found. Creating sample data for analysis.")
            # Create some dummy submissions with realistic data
            submissions = [
                {
                    "id": "sample1",
                    "username": "user1",
                    "timestamp": time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(time.time() - 86400)),
                    "imageUrl": "sample_url_1",
                    "location": {"lat": 40.8075, "lng": -73.9626},
                    "prompts": {
                        "mainSubject": "Open work area with natural light",
                        "context": "Modern university design studio, collaborative environment",
                        "avoid": "Clutter, dark corners, institutional feel",
                        "sliderValues": {
                            "naturalLight": 80,
                            "socialPrivacy": 60,
                            "spaceFlexibility": 75,
                            "comfortAtmosphere": 85
                        }
                    }
                },
                {
                    "id": "sample2",
                    "username": "user2",
                    "timestamp": time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(time.time() - 43200)),
                    "imageUrl": "sample_url_2",
                    "location": {"lat": 40.8080, "lng": -73.9630},
                    "prompts": {
                        "mainSubject": "Private study nooks with sound isolation",
                        "context": "Graduate student workspace with focus on individual work",
                        "avoid": "Sterile environment, noise, distraction",
                        "sliderValues": {
                            "naturalLight": 65,
                            "socialPrivacy": 85,
                            "spaceFlexibility": 40,
                            "comfortAtmosphere": 70
                        }
                    }
                },
                {
                    "id": "sample3",
                    "username": "user3",
                    "timestamp": time.strftime('%Y-%m-%d %H:%M:%S'),
                    "imageUrl": "sample_url_3",
                    "location": {"lat": 40.8085, "lng": -73.9640},
                    "prompts": {
                        "mainSubject": "Flexible meeting spaces with movable furniture",
                        "context": "Multi-purpose area for critiques and presentations",
                        "avoid": "Fixed layouts, poor sight lines, uncomfortable seating",
                        "sliderValues": {
                            "naturalLight": 70,
                            "socialPrivacy": 40,
                            "spaceFlexibility": 90,
                            "comfortAtmosphere": 75
                        }
                    }
                }
            ]
            logging.info(f"Created {len(submissions)} sample submissions for analysis")
        
        # Perform AI analysis
        analysis = analyze_submissions_with_ai(submissions)
        
        # Return the analysis
        return jsonify({
            "analysis": analysis,
            "submission_count": len(submissions),
            "generated_at": time.strftime('%Y-%m-%d %H:%M:%S')
        })
        
    except Exception as e:
        logging.error(f"Error in AI analysis API endpoint: {str(e)}")
        logging.error(traceback.format_exc())
        return jsonify({"error": str(e)}), 500

@socketio.on_error()
def error_handler(e):
    logger.error(f"WebSocket error: {str(e)}")
    logger.error(traceback.format_exc())

# Add a new route to proxy image requests
@app.route('/proxy-image')
def proxy_image():
    try:
        image_url = request.args.get('url')
        if not image_url:
            return jsonify({"error": "No URL provided"}), 400
            
        # Add headers to the request
        headers = {
            'User-Agent': 'Mozilla/5.0',
            'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Cache-Control': 'no-cache'
        }
            
        response = requests.get(image_url, stream=True, headers=headers)
        if response.status_code != 200:
            return jsonify({"error": "Failed to fetch image"}), response.status_code
            
        # Stream the response back with proper headers
        return Response(
            response.iter_content(chunk_size=8192),
            content_type=response.headers.get('content-type', 'image/jpeg'),
            headers={
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0'
            }
        )
    except Exception as e:
        logger.error(f"Error proxying image: {str(e)}")
        return jsonify({"error": str(e)}), 500

# Add security headers
@app.after_request
def add_security_headers(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
    response.headers['Access-Control-Allow-Credentials'] = 'true'
    response.headers['Access-Control-Expose-Headers'] = 'Content-Type'
    return response

@app.route('/api/analyze-custom', methods=['POST'])
def api_analyze_custom_submissions():
    """API endpoint to analyze a specific cluster of submissions"""
    try:
        # Get data from request
        data = request.get_json()
        
        if not data:
            return jsonify({"error": "No data provided"}), 400
            
        # Get submissions from request
        custom_submissions = data.get('submissions', [])
        cluster_location = data.get('cluster_location')
        
        if not custom_submissions:
            return jsonify({"error": "No submissions provided for analysis"}), 400
            
        # Log submission count
        logging.info(f"Analyzing {len(custom_submissions)} custom submissions")
        
        # If location data is provided, log it
        if cluster_location:
            logging.info(f"Cluster location: lat={cluster_location.get('lat')}, lng={cluster_location.get('lng')}")
        
        # Filter out dummy submissions or ones with incomplete data
        filtered_submissions = []
        for submission in custom_submissions:
            # Skip dummy submissions
            if 'imageUrl' in submission and ('dummy' in submission['imageUrl'] or 'placehold.co' in submission['imageUrl']):
                continue
                
            # Skip submissions without prompts
            if 'prompts' not in submission or not submission['prompts']:
                continue
                
            filtered_submissions.append(submission)
        
        # Log how many submissions were filtered out
        logging.info(f"Filtered submissions: {len(filtered_submissions)} of {len(custom_submissions)}")
        
        # If no valid submissions remain, return error
        if not filtered_submissions:
            return jsonify({
                "error": "No valid submissions found for analysis",
                "submission_count": 0,
                "generated_at": time.strftime('%Y-%m-%d %H:%M:%S'),
                "analysis": "No valid submissions found to analyze."
            }), 400
        
        # Perform AI analysis on the filtered submissions
        analysis = analyze_submissions_with_ai(filtered_submissions)
        
        # Return the analysis
        return jsonify({
            "analysis": analysis,
            "submission_count": len(filtered_submissions),
            "generated_at": time.strftime('%Y-%m-%d %H:%M:%S')
        })
        
    except Exception as e:
        logging.error(f"Error in custom AI analysis API endpoint: {str(e)}")
        logging.error(traceback.format_exc())
        return jsonify({"error": str(e)}), 500

@app.route('/api/generate-cluster-report', methods=['POST'])
def generate_cluster_report():
    """Generate a PDF report for a specific cluster of submissions"""
    try:
        # Get data from request
        data = request.form.get('cluster_data')
        
        if not data:
            return jsonify({"error": "No data provided"}), 400
            
        # Parse the JSON data
        cluster_data = json.loads(data)
        cluster_submissions = cluster_data.get('submissions', [])
        cluster_location = cluster_data.get('location')
        
        logging.info(f"Generating report for {len(cluster_submissions)} cluster submissions")
        
        # Filter out dummy submissions or ones with incomplete data
        filtered_submissions = []
        for submission in cluster_submissions:
            # Skip dummy submissions
            if 'imageUrl' in submission and ('dummy' in submission['imageUrl'] or 'placehold.co' in submission['imageUrl']):
                continue
                
            # Skip submissions without prompts
            if 'prompts' not in submission or not submission['prompts']:
                continue
                
            filtered_submissions.append(submission)
        
        # Import required libraries
        try:
            import io
            logging.info("Successfully imported io")
            
            from reportlab.lib.pagesizes import letter
            logging.info("Successfully imported reportlab.lib.pagesizes")
            
            from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Image, Table, TableStyle
            logging.info("Successfully imported reportlab.platypus")
            
            from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
            logging.info("Successfully imported reportlab.lib.styles")
            
            from reportlab.lib import colors
            logging.info("Successfully imported reportlab.lib.colors")
            
            from collections import Counter
            logging.info("Successfully imported collections.Counter")
            
            import requests
            logging.info("Successfully imported requests")
            
            try:
                from PIL import Image as PILImage
                logging.info("Successfully imported PIL.Image")
            except ImportError:
                logging.error("Failed to import PIL.Image. PDF will have limited image support.")
                PILImage = None
            
            try:
                from wordcloud import WordCloud
                logging.info("Successfully imported wordcloud.WordCloud")
            except ImportError:
                logging.error("Failed to import wordcloud. PDF will not include word clouds.")
                WordCloud = None
                
            try:
                import matplotlib.pyplot as plt
                import numpy as np
                logging.info("Successfully imported matplotlib and numpy")
                
                # Use Agg backend (non-interactive, does not require a display)
                import matplotlib
                matplotlib.use('Agg')
                logging.info("Set matplotlib backend to Agg")
            except ImportError as e:
                logging.error(f"Failed to import matplotlib/numpy: {str(e)}. PDF will not include charts.")
                plt = None
                np = None
                
        except ImportError as e:
            logging.error(f"Missing required library: {str(e)}")
            return jsonify({
                "error": f"Missing required library for PDF generation: {str(e)}. Install with: pip install reportlab pillow matplotlib wordcloud"
            }), 500
        
        # Create an in-memory PDF
        buffer = io.BytesIO()
        
        # Create the PDF document
        doc = SimpleDocTemplate(buffer, pagesize=letter)
        styles = getSampleStyleSheet()
        
        # Create custom styles
        title_style = ParagraphStyle(
            'TitleStyle',
            parent=styles['Heading1'],
            fontSize=24,
            textColor=colors.blue,
            spaceAfter=12
        )
        
        heading_style = ParagraphStyle(
            'HeadingStyle',
            parent=styles['Heading2'],
            fontSize=18,
            textColor=colors.darkblue,
            spaceAfter=10,
            spaceBefore=20
        )
        
        subheading_style = ParagraphStyle(
            'SubheadingStyle',
            parent=styles['Heading3'],
            fontSize=14,
            textColor=colors.darkblue,
            spaceAfter=6,
            spaceBefore=10
        )
        
        normal_style = ParagraphStyle(
            'NormalStyle',
            parent=styles['Normal'],
            fontSize=10,
            spaceAfter=6
        )
        
        # Initialize the PDF content
        elements = []
        
        # Add title
        if cluster_location:
            lat = round(cluster_location['lat'], 4)
            lng = round(cluster_location['lng'], 4)
            elements.append(Paragraph(f"Cluster Submissions Report - Location ({lat}, {lng})", title_style))
        else:
            elements.append(Paragraph("Cluster Submissions Report", title_style))
        elements.append(Spacer(1, 12))
        
        # Add summary
        elements.append(Paragraph(f"Total Submissions: {len(filtered_submissions)}", heading_style))
        elements.append(Paragraph(f"Report Generated: {time.strftime('%Y-%m-%d %H:%M:%S')}", normal_style))
        elements.append(Spacer(1, 12))
        
        # Add AI Analysis Section
        elements.append(Paragraph("AI Analysis of Cluster Submissions", heading_style))
        
        # Generate AI analysis
        ai_analysis = analyze_submissions_with_ai(filtered_submissions)
        
        # Split the analysis into paragraphs and add to PDF
        if ai_analysis:
            for paragraph in ai_analysis.split('\n\n'):
                if paragraph.strip():
                    # Check if this is a section header (indicated by ending with ":")
                    if paragraph.strip().endswith(':'):
                        elements.append(Paragraph(paragraph, subheading_style))
                    # Check if this is a bullet point
                    elif paragraph.strip().startswith('•') or paragraph.strip().startswith('-'):
                        elements.append(Paragraph(paragraph, normal_style))
                    else:
                        elements.append(Paragraph(paragraph, normal_style))
            
            elements.append(Spacer(1, 20))
        
        # Add analysis of common themes from prompts
        elements.append(Paragraph("Common Themes Analysis", heading_style))
        
        # Collect all main subjects and context prompts
        all_main_subjects = []
        all_contexts = []
        all_avoid_terms = []
        
        # Collect slider values
        sunlight_values = []
        movement_values = []
        privacy_values = []
        harmony_values = []
        
        # Aggregate data from all submissions
        for submission in filtered_submissions:
            prompts = submission.get('prompts', {})
            
            # Main subject
            main_subject = prompts.get('mainSubject', '')
            if main_subject and main_subject != 'N/A':
                all_main_subjects.extend(main_subject.lower().split())
            
            # Context
            context = prompts.get('context', '')
            if context and context != 'N/A':
                all_contexts.extend(context.lower().split())
            
            # Avoid terms
            avoid = prompts.get('avoid', '')
            if avoid and avoid != 'N/A':
                all_avoid_terms.extend(avoid.lower().split())
            
            # Slider values
            slider_values = prompts.get('sliderValues', {})
            if slider_values:
                try:
                    sunlight_values.append(float(slider_values.get('sunlight', 0)))
                    movement_values.append(float(slider_values.get('movement', 0)))
                    privacy_values.append(float(slider_values.get('privacy', 0)))
                    harmony_values.append(float(slider_values.get('harmony', 0)))
                except (ValueError, TypeError):
                    pass
        
        # Filter out common stop words
        stop_words = {'the', 'and', 'to', 'a', 'in', 'of', 'with', 'is', 'that', 'for', 'on', 'at', 'this', 'an', 'by'}
        filtered_main_subjects = [word for word in all_main_subjects if word.lower() not in stop_words and len(word) > 2]
        filtered_contexts = [word for word in all_contexts if word.lower() not in stop_words and len(word) > 2]
        filtered_avoid_terms = [word for word in all_avoid_terms if word.lower() not in stop_words and len(word) > 2]
        
        # Get most common terms for each category
        main_subject_counter = Counter(filtered_main_subjects)
        context_counter = Counter(filtered_contexts)
        avoid_counter = Counter(filtered_avoid_terms)
        
        # Function to get top N items from counter
        def get_top_items(counter, n=10):
            return counter.most_common(n)
        
        # Add common themes data
        main_subject_terms = get_top_items(main_subject_counter, 5)
        context_terms = get_top_items(context_counter, 5)
        avoid_terms = get_top_items(avoid_counter, 5)
        
        # Create a table for common themes
        if main_subject_terms or context_terms or avoid_terms:
            elements.append(Paragraph("Most Common Terms in Prompts", subheading_style))
            theme_data = [["Category", "Term", "Frequency"]]
            
            for term, count in main_subject_terms:
                theme_data.append(["Main Subject", term, str(count)])
            
            for term, count in context_terms:
                theme_data.append(["Context", term, str(count)])
            
            for term, count in avoid_terms:
                theme_data.append(["Avoid", term, str(count)])
            
            theme_table = Table(theme_data, colWidths=[120, 200, 80])
            theme_table.setStyle(TableStyle([
                ('BACKGROUND', (0, 0), (-1, 0), colors.lightblue),
                ('TEXTCOLOR', (0, 0), (-1, 0), colors.black),
                ('ALIGN', (0, 0), (-1, 0), 'CENTER'),
                ('FONTNAME', (0, 0), (-1, 0), 'Helvetica-Bold'),
                ('FONTSIZE', (0, 0), (-1, 0), 12),
                ('BOTTOMPADDING', (0, 0), (-1, 0), 12),
                ('BACKGROUND', (0, 1), (-1, -1), colors.white),
                ('TEXTCOLOR', (0, 1), (-1, -1), colors.black),
                ('ALIGN', (0, 1), (-1, -1), 'LEFT'),
                ('FONTNAME', (0, 1), (-1, -1), 'Helvetica'),
                ('FONTSIZE', (0, 1), (-1, -1), 10),
                ('GRID', (0, 0), (-1, -1), 1, colors.black),
            ]))
            elements.append(theme_table)
            elements.append(Spacer(1, 12))
        
        # Generate word cloud if there are enough words and wordcloud is available
        try:
            if WordCloud is not None and len(filtered_main_subjects) > 10:
                elements.append(Paragraph("Word Cloud from All Prompts", subheading_style))
                
                # Combine all filtered words for the word cloud
                all_words = filtered_main_subjects + filtered_contexts
                all_words_text = ' '.join(all_words)
                
                # Generate word cloud
                wordcloud = WordCloud(width=600, height=300, background_color='white', 
                                    max_words=100, contour_width=1, contour_color='steelblue')
                wordcloud.generate(all_words_text)
                
                # Save word cloud to a temporary buffer
                wordcloud_img_buffer = io.BytesIO()
                plt.figure(figsize=(8, 4))
                plt.imshow(wordcloud, interpolation='bilinear')
                plt.axis("off")
                plt.tight_layout(pad=0)
                plt.savefig(wordcloud_img_buffer, format='png')
                plt.close()
                
                # Add word cloud image to PDF
                wordcloud_img_buffer.seek(0)
                wordcloud_img = Image(wordcloud_img_buffer, width=400, height=200)
                elements.append(wordcloud_img)
                elements.append(Spacer(1, 20))
        except Exception as wordcloud_error:
            logging.error(f"Error generating word cloud: {str(wordcloud_error)}")
            elements.append(Paragraph(f"Word cloud generation failed: {str(wordcloud_error)}", normal_style))
            elements.append(Spacer(1, 10))
        
        # Generate the PDF
        doc.build(elements)
        
        # Get the PDF value
        pdf_value = buffer.getvalue()
        buffer.close()
        
        # Return the PDF
        return send_file(
            io.BytesIO(pdf_value),
            mimetype='application/pdf',
            as_attachment=True,
            download_name='cluster_submissions_report.pdf',
            etag=False,
            last_modified=None,
            max_age=None
        )
        
    except Exception as e:
        logging.error(f"Error generating cluster report: {str(e)}")
        logging.error(traceback.format_exc())
        return jsonify({"error": str(e)}), 500

@socketio.on('get_submissions')
def handle_get_submissions():
    try:
        # Load submissions from CSV
        submissions = load_submissions_from_csv()
        logger.info(f"Sending {len(submissions)} submissions to client")
        
        # Send submissions to the requesting client
        emit('submissions_list', {
            'submissions': submissions
        })
    except Exception as e:
        logger.error(f"Error handling get_submissions request: {str(e)}")
        logger.error(traceback.format_exc())
        emit('submissions_list', {
            'submissions': []
        })

if __name__ == '__main__':
    logger.info("Starting Flask server...")
    logger.info("Make sure ComfyUI is running on http://127.0.0.1:8188")
    
    # Add more detailed logging for incoming connections
    @app.before_request
    def log_request_info():
        logger.info('Headers: %s', request.headers)
        logger.info('Body: %s', request.get_data())
        logger.info('Remote Address: %s', request.remote_addr)
        logger.info('Request URL: %s', request.url)
        logger.info('Request Method: %s', request.method)
    
    try:
        socketio.run(app, 
                    debug=True, 
                    host='0.0.0.0', 
                    port=3000,
                    log_output=True)
    except Exception as e:
        logger.error(f"Error starting server: {str(e)}")
        logger.error(traceback.format_exc()) 